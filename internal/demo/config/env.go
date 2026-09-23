package config

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	Join  string
	Email string
}

func Load() (*Config, error) {
	join := strings.TrimSpace(os.Getenv("XTR_JOIN"))
	email := strings.TrimSpace(os.Getenv("XTR_ACCOUNT_EMAIL"))

	if join == "" {
		return nil, errors.New("XTR_JOIN is required (format: https://api.example.com|<secret>)")
	}
	if email == "" {
		return nil, errors.New("XTR_ACCOUNT_EMAIL is required")
	}

	parts := strings.SplitN(join, "|", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, errors.New("XTR_JOIN must be '<url>|<secret>'")
	}

	return &Config{Join: join, Email: email}, nil
}

func MaskJoin(join string) string {
	parts := strings.SplitN(join, "|", 2)
	if len(parts) != 2 {
		return "(invalid)"
	}
	secret := parts[1]
	if len(secret) <= 4 {
		return parts[0] + "|****"
	}
	return parts[0] + "|" + secret[:2] + "****" + secret[len(secret)-2:]
}
