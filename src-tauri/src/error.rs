use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Clé fal.ai manquante : ajoutez-la depuis la page d'accueil (« Clé fal.ai » en bas à gauche)")]
    MissingKey,
    #[error("{0}")]
    Invalid(String),
    #[error("fal.ai : {0}")]
    Fal(String),
    #[error("Réseau : {0}")]
    Http(#[from] reqwest::Error),
    #[error("Fichier : {0}")]
    Io(#[from] std::io::Error),
    #[error("Trousseau : {0}")]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
}

// Commands return errors to JS as plain strings.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
