use esp_idf_svc::nvs::EspDefaultNvsPartition;
use std::ffi::c_void;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use esp_idf_svc::hal::gpio::{Input, PinDriver, Pull};
use esp_idf_svc::hal::peripherals::Peripherals;
use esp_idf_svc::sys;

mod portal;

// Flags shared by the Wi-Fi callback and main loop.
static WIFI_READY: AtomicBool = AtomicBool::new(false);
static CREDENTIALS_SAVED: AtomicBool = AtomicBool::new(false);
static PROVISIONING_STARTED: AtomicBool = AtomicBool::new(false);
static PROVISIONING_STOPPED: AtomicBool = AtomicBool::new(false);

// Limit setup sessions only when saved profiles are available to return to.
const PROVISIONING_TIMEOUT: Duration = Duration::from_secs(180);

// Built from src/web; static bytes remain valid for the native HTTP server.
const PORTAL_HTML: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/portal.html"));

// Use the generated C bindings so event IDs stay aligned with the component.
const ESP_WIFI_SERVICE_EVENT_DISCONNECTED: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_DISCONNECTED as u16;

const ESP_WIFI_SERVICE_EVENT_PROV_CREDENTIAL_RECEIVED: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_PROV_CREDENTIAL_RECEIVED as u16;

const ESP_WIFI_SERVICE_EVENT_STA_GOT_IP: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_STA_GOT_IP as u16;

const ESP_WIFI_SERVICE_EVENT_STA_LOST_IP: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_STA_LOST_IP as u16;

const ESP_WIFI_SERVICE_EVENT_PROV_STOPPED: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_PROV_STOPPED as u16;

const ESP_WIFI_SERVICE_EVENT_PROV_STARTED: u16 =
    sys::esp_wifi_service_event_t_ESP_WIFI_SERVICE_EVENT_PROV_STARTED as u16;

// Called by ESP-IDF when a Wi-Fi service event is published.
unsafe extern "C" fn wifi_event_handler(event: *const sys::adf_event_t, _ctx: *mut c_void) {
    let Some(event) = (unsafe { event.as_ref() }) else {
        return;
    };

    match event.event_id {
        ESP_WIFI_SERVICE_EVENT_STA_GOT_IP => {
            WIFI_READY.store(true, Ordering::Relaxed);
        }

        ESP_WIFI_SERVICE_EVENT_STA_LOST_IP | ESP_WIFI_SERVICE_EVENT_DISCONNECTED => {
            WIFI_READY.store(false, Ordering::Relaxed);
        }

        ESP_WIFI_SERVICE_EVENT_PROV_CREDENTIAL_RECEIVED => {
            CREDENTIALS_SAVED.store(true, Ordering::Relaxed);
        }

        ESP_WIFI_SERVICE_EVENT_PROV_STARTED => {
            PROVISIONING_STARTED.store(true, Ordering::Relaxed);
        }

        ESP_WIFI_SERVICE_EVENT_PROV_STOPPED => {
            PROVISIONING_STOPPED.store(true, Ordering::Relaxed);
        }

        _ => {}
    }
}

// Only for essential startup steps: continuing would use missing or partially
// initialized services. Restart without dropping configuration borrowed by C.
// Runtime errors stay in the main loop and keep that configuration alive.
fn or_restart<T>(operation: &str, result: Result<T, sys::EspError>) -> T {
    result.unwrap_or_else(|error| {
        log::error!("{operation} failed: {error}; restarting in 5 seconds");
        thread::sleep(Duration::from_secs(5));
        unsafe { sys::esp_restart() }
    })
}

fn has_saved_profiles(
    profiles: sys::esp_wifi_service_profile_mgr_t,
) -> Result<bool, sys::EspError> {
    let mut count = 0;
    sys::esp!(unsafe { sys::esp_wifi_service_profile_mgr_count(profiles, &mut count) })?;
    Ok(count > 0)
}

fn resume_saved_wifi(wifi: *mut sys::esp_wifi_service_t) {
    if let Err(error) = sys::esp!(unsafe { sys::esp_wifi_service_request_reeval(wifi) }) {
        if error.code() != sys::ESP_ERR_NOT_FOUND {
            log::warn!("Could not resume saved Wi-Fi: {error}; hold BOOT to reopen setup");
        }
    }
}

fn main() -> ! {
    setup();

    // 1. Initialize the default NVS partition.
    let _nvs_partition = or_restart("Initialize NVS", EspDefaultNvsPartition::take_with(false));

    // 2. Configure persistent Wi-Fi profile storage.
    // The C backend borrows this configuration: keep its allocation alive for the service lifetime.
    let storage_config = Box::new(sys::esp_config_storage_nvs_t {
        nvs_namespace: c"hello_wifi".as_ptr(),
        key_primary: c"profiles_a".as_ptr(),
        key_backup: c"profiles_b".as_ptr(),
    });

    let mut storage: sys::esp_config_storage_t = null_mut();

    or_restart(
        "Initialize storage",
        sys::esp!(unsafe {
            sys::esp_config_storage_init_nvs(storage_config.as_ref(), &mut storage)
        }),
    );

    // 3. Create the Wi-Fi profile manager.
    let profile_config = sys::esp_wifi_service_profile_mgr_cfg_t {
        max_profiles: 3,
        storage,
        crypto: null(),
        crypto_extra_size: 0,
    };

    let mut profiles: sys::esp_wifi_service_profile_mgr_t = null_mut();

    or_restart(
        "Initialize profiles",
        sys::esp!(unsafe {
            sys::esp_wifi_service_profile_mgr_init(&profile_config, &mut profiles)
        }),
    );

    // 4. Configure the built-in HTTP provisioning agent.
    let mut http: sys::esp_wifi_service_prov_http_config_t = Default::default();

    http.name = c"http".as_ptr();
    http.port = 80;
    http.profile_manager = profiles;
    http.register_cb = Some(portal::register_routes);
    http.register_ctx = profiles;
    http.default_priority = 10;

    http.softap.ssid = c"Hello-WiFi-Setup".as_ptr();
    http.softap.password = c"hello-setup-1234".as_ptr();

    http.web_ui.data = PORTAL_HTML.as_ptr();
    http.web_ui.data_len = PORTAL_HTML.len() as _;
    http.web_ui.path = c"/".as_ptr();
    http.web_ui.content_type = c"text/html; charset=utf-8".as_ptr();

    let mut agent: sys::esp_wifi_service_prov_t = null_mut();

    or_restart(
        "Create HTTP agent",
        sys::esp!(unsafe { sys::esp_wifi_service_prov_http_create(&http, &mut agent,) }),
    );

    // 5. Create Wi-Fi service with its default selector.
    let wifi_config = sys::esp_wifi_service_config_t {
        name: c"wifi_service".as_ptr(),
        profile_manager: profiles,
        prov_list: &mut agent,
        prov_num: 1,
        selector_policy: null(),
    };

    let mut wifi: *mut sys::esp_wifi_service_t = null_mut();

    or_restart(
        "Create Wi-Fi service",
        sys::esp!(unsafe { sys::esp_wifi_service_create(&wifi_config, &mut wifi,) }),
    );

    // 6. Subscribe before starting the service.
    let service = wifi.cast::<sys::esp_service_t>();

    let mut subscription: sys::adf_event_subscribe_info_t = Default::default();

    subscription.event_id = u16::MAX; // ADF_EVENT_ANY_ID
    subscription.handler = Some(wifi_event_handler);

    or_restart(
        "Subscribe to Wi-Fi events",
        sys::esp!(unsafe { sys::esp_service_event_subscribe(service, &subscription,) }),
    );

    // Saved profiles -> start connecting.
    // No profiles    -> start the provisioning portal.
    or_restart(
        "Start Wi-Fi service",
        sys::esp!(unsafe { sys::esp_service_start(service) }),
    );

    // 7. Configure the BOOT button (GPIO9 on the target ESP32-C6 board).
    let boot = match Peripherals::take()
        .and_then(|peripherals| PinDriver::input(peripherals.pins.gpio9, Pull::Up))
    {
        Ok(boot) => Some(boot),
        Err(error) => {
            log::error!("BOOT button unavailable: {error}; continuing without button support");
            None
        }
    };

    let mut pressed_since: Option<Instant> = None;
    let mut press_handled = false;
    let mut next_hello = Instant::now();
    let mut provisioning_deadline: Option<Instant> = None;

    log::info!("Wi-Fi service started");
    log::info!("With no saved profiles, join Hello-WiFi-Setup (password: hello-setup-1234)");
    log::info!("Open http://192.168.4.1/ to configure Wi-Fi; hold BOOT for 5s to reopen setup");

    // 8. Main application loop.
    loop {
        handle_provisioning(wifi, profiles, &mut provisioning_deadline);
        poll_boot_button(boot.as_ref(), wifi, &mut pressed_since, &mut press_handled);

        // Hello World application.
        if WIFI_READY.load(Ordering::Relaxed) && Instant::now() >= next_hello {
            log::info!("Hello, Wi-Fi!");

            next_hello = Instant::now() + Duration::from_secs(5);
        }

        thread::sleep(Duration::from_millis(100));
    }
}

fn handle_provisioning(
    wifi: *mut sys::esp_wifi_service_t,
    profiles: sys::esp_wifi_service_profile_mgr_t,
    provisioning_deadline: &mut Option<Instant>,
) {
    handle_provisioning_notifications(wifi, profiles, provisioning_deadline);
    check_provisioning_timeout(wifi, profiles, provisioning_deadline);
    handle_provisioning_stopped(wifi, provisioning_deadline);
}

fn handle_provisioning_notifications(
    wifi: *mut sys::esp_wifi_service_t,
    profiles: sys::esp_wifi_service_profile_mgr_t,
    provisioning_deadline: &mut Option<Instant>,
) {
    if PROVISIONING_STARTED.swap(false, Ordering::Relaxed) {
        *provisioning_deadline = None;
        match has_saved_profiles(profiles) {
            Ok(true) => {
                *provisioning_deadline = Some(Instant::now() + PROVISIONING_TIMEOUT);
                log::info!("Provisioning will time out after 180 seconds");
            }
            Ok(false) => log::info!("No saved profiles; provisioning has no timeout"),
            Err(error) => {
                log::warn!("Cannot count saved profiles: {error}; keeping provisioning open");
            }
        }
    }

    if CREDENTIALS_SAVED.swap(false, Ordering::Relaxed) {
        *provisioning_deadline = None;
        log::info!("Wi-Fi credentials saved");
        // Give the HTTP response time to reach the browser before closing it.
        thread::sleep(Duration::from_millis(500));
        if let Err(error) = sys::esp!(unsafe { sys::esp_wifi_service_stop_provisioning(wifi) }) {
            log::warn!("Could not stop provisioning: {error}; use the portal to retry");
        }
    }
}

fn check_provisioning_timeout(
    wifi: *mut sys::esp_wifi_service_t,
    profiles: sys::esp_wifi_service_profile_mgr_t,
    provisioning_deadline: &mut Option<Instant>,
) {
    if provisioning_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
        *provisioning_deadline = None;
        // The last saved profile may have been removed during this session.
        match has_saved_profiles(profiles) {
            Ok(true) => {
                log::info!("Provisioning timed out; returning to saved Wi-Fi");
                if let Err(error) =
                    sys::esp!(unsafe { sys::esp_wifi_service_stop_provisioning(wifi) })
                {
                    log::warn!("Could not stop provisioning: {error}; use the portal to retry");
                }
            }
            Ok(false) => log::info!("No saved profiles; keeping provisioning open"),
            Err(error) => {
                log::warn!("Cannot count saved profiles: {error}; keeping provisioning open");
            }
        }
    }
}

fn handle_provisioning_stopped(
    wifi: *mut sys::esp_wifi_service_t,
    provisioning_deadline: &mut Option<Instant>,
) {
    if PROVISIONING_STOPPED.swap(false, Ordering::Relaxed) {
        *provisioning_deadline = None;
        // The browser stops the HTTP agent; main resumes the native selector.
        resume_saved_wifi(wifi);
    }
}

fn poll_boot_button(
    boot: Option<&PinDriver<'_, Input>>,
    wifi: *mut sys::esp_wifi_service_t,
    pressed_since: &mut Option<Instant>,
    press_handled: &mut bool,
) {
    // Hold BOOT for five seconds to re-enter provisioning.
    if boot.is_some_and(|boot| boot.is_low()) {
        let start = pressed_since.get_or_insert_with(Instant::now);

        if !*press_handled && start.elapsed() >= Duration::from_secs(5) {
            *press_handled = true;

            let mut running = false;
            match sys::esp!(unsafe {
                sys::esp_wifi_service_is_provisioning_running(wifi, &mut running)
            }) {
                Ok(()) if !running => {
                    log::info!("Starting Wi-Fi provisioning");
                    if let Err(error) =
                        sys::esp!(unsafe { sys::esp_wifi_service_start_provisioning(wifi) })
                    {
                        log::warn!(
                            "Could not start provisioning: {error}; release and hold BOOT to retry"
                        );
                        // Starting setup disconnects Wi-Fi before opening the
                        // portal. Try to restore saved Wi-Fi if opening fails.
                        resume_saved_wifi(wifi);
                    }
                }
                Ok(()) => {}
                Err(error) => {
                    log::warn!(
                        "Cannot read provisioning state: {error}; release and hold BOOT to retry"
                    );
                }
            }
        }
    } else {
        *pressed_since = None;
        *press_handled = false;
    }
}

fn setup() {
    // It is necessary to call this function once. Otherwise, some patches to the runtime
    // implemented by esp-idf-sys might not link properly. See https://github.com/esp-rs/esp-idf-template/issues/71
    sys::link_patches();

    // Bind the log crate to the ESP Logging facilities
    esp_idf_svc::log::EspLogger::initialize_default();
}
