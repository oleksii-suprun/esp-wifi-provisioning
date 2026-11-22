use esp_idf_svc::sys;
use std::ffi::{CStr, c_void};

// esp_wifi_service 0.5.3 does not URL-decode SSIDs in DELETE /prov/profiles.
// Accept the SSID as a plain-text body and reuse its native profile manager.
pub unsafe extern "C" fn register_routes(
    server: *mut c_void,
    profiles: *mut c_void,
) -> sys::esp_err_t {
    let route = sys::httpd_uri_t {
        uri: c"/app/forget".as_ptr(),
        method: sys::http_method_HTTP_POST,
        handler: Some(forget),
        user_ctx: profiles,
        ..Default::default()
    };
    // The native server copies the route; profiles lives as long as the service.
    unsafe { sys::httpd_register_uri_handler(server, &route) }
}

unsafe extern "C" fn forget(req: *mut sys::httpd_req_t) -> sys::esp_err_t {
    let Some(request) = (unsafe { req.as_ref() }) else {
        return sys::ESP_ERR_INVALID_ARG;
    };
    let len = request.content_len;
    if !(1..=32).contains(&len) || request.user_ctx.is_null() {
        return unsafe {
            reply(
                req,
                c"400 Bad Request",
                br#"{"error":"Invalid network name."}"#,
            )
        };
    }
    let profiles = request.user_ctx;
    let mut name = [0u8; 33];
    let mut received = 0;
    while received < len {
        let count = unsafe {
            sys::httpd_req_recv(req, name[received..].as_mut_ptr().cast(), len - received)
        };
        if count <= 0 {
            // Let the server close an incomplete request without deleting anything.
            return sys::ESP_FAIL;
        }
        received += count as usize;
    }
    let Ok(ssid) = CStr::from_bytes_with_nul(&name[..=len]) else {
        return unsafe {
            reply(
                req,
                c"400 Bad Request",
                br#"{"error":"Invalid network name."}"#,
            )
        };
    };
    let profile_count = || {
        let mut count = 0;
        let result = unsafe { sys::esp_wifi_service_profile_mgr_count(profiles, &mut count) };
        (result == sys::ESP_OK).then_some(count)
    };
    let before = profile_count();
    let result = unsafe { sys::esp_wifi_service_profile_mgr_delete(profiles, ssid.as_ptr()) };
    log::info!(
        "Forget {ssid:?}: result={result}, saved profiles {before:?} -> {:?}",
        profile_count()
    );
    if result != sys::ESP_OK {
        return unsafe {
            reply(
                req,
                c"500 Internal Server Error",
                br#"{"error":"Could not remove the saved network."}"#,
            )
        };
    }
    unsafe { reply(req, c"200 OK", br#"{"result":"ok"}"#) }
}

unsafe fn reply(req: *mut sys::httpd_req_t, status: &CStr, body: &[u8]) -> sys::esp_err_t {
    let result = unsafe { sys::httpd_resp_set_status(req, status.as_ptr()) };
    if result != sys::ESP_OK {
        return result;
    }
    let result = unsafe { sys::httpd_resp_set_type(req, c"application/json".as_ptr()) };
    if result != sys::ESP_OK {
        return result;
    }
    unsafe { sys::httpd_resp_send(req, body.as_ptr().cast(), body.len() as _) }
}
