use std::{env, fs, path::PathBuf};

fn main() {
    embuild::espidf::sysenv::output();
    embedd_web_assets_into_index();
}

fn embedd_web_assets_into_index() {
    // Keep editable assets separate, but serve one self-contained page on the ESP.
    let html = fs::read_to_string("src/web/index.html").expect("read portal HTML");
    let css = fs::read_to_string("src/web/style.css").expect("read portal CSS");
    let js = fs::read_to_string("src/web/app.js").expect("read portal JavaScript");
    let style_tag = r#"<link rel="stylesheet" href="style.css">"#;
    let script_tag = r#"<script src="app.js"></script>"#;

    assert_eq!(
        html.matches(style_tag).count(),
        1,
        "missing CSS bundle marker"
    );

    assert_eq!(
        html.matches(script_tag).count(),
        1,
        "missing JS bundle marker"
    );

    assert!(
        !css.to_ascii_lowercase().contains("</style>"),
        "CSS bundle contains closing tag"
    );

    assert!(
        !js.to_ascii_lowercase().contains("</script>"),
        "JS bundle contains closing tag"
    );

    let page = html
        .replace(style_tag, &format!("<style>{css}</style>"))
        .replace(script_tag, &format!("<script>{js}</script>"));

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    fs::write(out_dir.join("portal.html"), page).expect("write bundled portal");

    for asset in ["index.html", "style.css", "app.js"] {
        println!("cargo:rerun-if-changed=src/web/{asset}");
    }
}
