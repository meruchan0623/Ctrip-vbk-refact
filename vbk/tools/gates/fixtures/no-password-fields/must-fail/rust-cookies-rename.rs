#[derive(Serialize)]
pub struct Jar {
    #[serde(rename = "cookies")]
    pub jar: Vec<String>,
}
