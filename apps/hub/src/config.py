from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List

class Settings(BaseSettings):
    APP_NAME: str = Field(default="ProjectPlant Hub")
    APP_VERSION: str = Field(default="0.1.0")
    DEBUG: bool = Field(default=True)
    CORS_ORIGINS: List[str] = Field(default_factory=lambda: ["*"])
    PORT: int = Field(default=8000)

    class Config:
        env_file = ".env"

settings = Settings()
