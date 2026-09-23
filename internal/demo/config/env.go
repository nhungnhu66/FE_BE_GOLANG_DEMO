package config

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	Email string
}

func Load() (*Config, error) {
	email := strings.TrimSpace(os.Getenv("XTR_ACCOUNT_EMAIL"))
	if email == "" {
		return nil, errors.New("missing email")
	}
	return &Config{Email: email}, nil
}
