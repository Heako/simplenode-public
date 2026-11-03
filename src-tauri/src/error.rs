use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Missing fal.ai key: add it in Settings → fal.ai API key. Without fal, only the models WaveSpeed hosts can run")]
    MissingKey,
    #[error("Add your WaveSpeed key in Settings → WaveSpeed")]
    MissingWaveSpeedKey,
    #[error("WaveSpeed: {0}")]
    WaveSpeed(String),
    #[error("{0}")]
    Invalid(String),
    #[error("fal.ai: {0}")]
    Fal(String),
    #[error("Add your BytePlus key in Settings → BytePlus ModelArk")]
    MissingBytePlusKey,
    #[error("BytePlus portraits require an Access Key and a Secret Key: add them in Settings → BytePlus ModelArk")]
    MissingBytePlusAkSk,
    #[error("BytePlus: {0}")]
    BytePlus(String),
    /// The provider turned the request down before generating anything.
    #[error("{0}")]
    Refused(String),
    #[error("Network: {0}")]
    Http(#[from] reqwest::Error),
    #[error("File: {0}")]
    Io(#[from] std::io::Error),
    #[error("Keychain: {0}")]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

impl AppError {
    /// Failed before any provider started (and billed) a generation: a
    /// missing key, an invalid input, or a request the provider refused.
    pub fn unbilled(&self) -> bool {
        matches!(self, AppError::MissingKey | AppError::MissingWaveSpeedKey | AppError::MissingBytePlusKey | AppError::MissingBytePlusAkSk | AppError::Invalid(_) | AppError::Refused(_))
    }
}

/// Error of a command whose cost the MCP budget counted: says whether that
/// amount can be given back.
#[derive(Serialize)]
pub struct CommandError {
    message: String,
    unbilled: bool,
}

impl From<AppError> for CommandError {
    fn from(e: AppError) -> Self {
        Self { unbilled: e.unbilled(), message: e.to_string() }
    }
}

// Commands return errors to JS as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
