"""Application configuration, loaded from the environment."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="IAM_", env_file=".env", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@127.0.0.1:5432/iam_py"
    jwt_secret: str = "dev-only-change-me"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 60
    seed_on_start: bool = True
    # Secret encryption key for stored connector credentials (Fernet-style key in prod).
    credential_key: str = "dev-credential-key-change-me"


@lru_cache
def get_settings() -> Settings:
    return Settings()
