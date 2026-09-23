package config

import (
	"errors"
	"os"
	"strings"
)

const (
	requiredUserAgent = "mimo-claw"
	defaultGatewayURL = "https://api.xkiro.com"
	defaultGatewayPath = "/socket.io"
)

// Config — cấu hình gateway đọc từ env container.
type Config struct {
	GatewayURL    string
	GatewaySecret string
	GatewayPath   string
	AccountEmail  string
	APIKey        string
}

// EnvCandidates — tên biến môi trường gateway/upstream thường gặp trên container MiMo.
var EnvCandidates = []string{
	"XTR_JOIN",
	"XTR_GATEWAY_URL",
	"XTR_GATEWAY_SECRET",
	"XTROUTER_GATEWAY_URL",
	"XTROUTER_GATEWAY_SECRET",
	"XTR_GATEWAY_PATH",
	"XTR_ACCOUNT_EMAIL",
	"MIMO_ACCOUNT_EMAIL",
	"XIAOMI_ACCOUNT_EMAIL",
	"MIMO_API_KEY",
	"MIMO_KEY",
	"XIAOMI_MIMO_API_KEY",
}

func Load() (*Config, error) {
	join := strings.TrimSpace(os.Getenv("XTR_JOIN"))
	email := strings.TrimSpace(firstEnv(
		"XTR_ACCOUNT_EMAIL", "MIMO_ACCOUNT_EMAIL", "XIAOMI_ACCOUNT_EMAIL",
	))
	apiKey := strings.TrimSpace(firstEnv(
		"MIMO_API_KEY", "MIMO_KEY", "XIAOMI_MIMO_API_KEY",
	))

	url, secret := splitJoin(join)
	if url == "" {
		url = strings.TrimSpace(firstEnv("XTR_GATEWAY_URL", "XTROUTER_GATEWAY_URL"))
	}
	if url == "" {
		url = defaultGatewayURL
	}
	if secret == "" {
		secret = strings.TrimSpace(firstEnv("XTR_GATEWAY_SECRET", "XTROUTER_GATEWAY_SECRET"))
	}
	path := strings.TrimSpace(os.Getenv("XTR_GATEWAY_PATH"))
	if path == "" {
		path = defaultGatewayPath
	}

	if join == "" && secret == "" {
		return nil, errors.New("XTR_JOIN is required (format: https://api.example.com|<secret>)")
	}
	if email == "" {
		return nil, errors.New("XTR_ACCOUNT_EMAIL is required")
	}
	if apiKey == "" {
		return nil, errors.New("MIMO_API_KEY is required")
	}

	return &Config{
		GatewayURL:    url,
		GatewaySecret: secret,
		GatewayPath:   path,
		AccountEmail:  email,
		APIKey:        apiKey,
	}, nil
}

func firstEnv(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(os.Getenv(n)); v != "" {
			return v
		}
	}
	return ""
}

func splitJoin(raw string) (url, secret string) {
	at := strings.LastIndex(raw, "|")
	if at < 0 {
		return "", strings.TrimSpace(raw)
	}
	return strings.TrimSpace(raw[:at]), strings.TrimSpace(raw[at+1:])
}

func MaskSecret(v string) string {
	if len(v) <= 4 {
		return "****"
	}
	return v[:2] + "****" + v[len(v)-2:]
}

func RequiredUserAgent() string { return requiredUserAgent }
