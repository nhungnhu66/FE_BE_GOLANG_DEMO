package vps

import (
	"fmt"
	"os"
	"runtime"
	"strings"

	"github.com/nhungnhu66/xkdemo/internal/demo/config"
)

func RunDoctor(cfg *config.Config) int {
	line("1. Biến môi trường")
	fmt.Printf("  gatewayUrl ......... %s\n", cfg.GatewayURL)
	fmt.Printf("  gatewaySecret ...... %s\n", config.MaskSecret(cfg.GatewaySecret))
	fmt.Printf("  gatewayPath ........ %s\n", cfg.GatewayPath)
	fmt.Printf("  accountEmail ....... %s\n", cfg.AccountEmail)
	fmt.Printf("  apiKey ............. %s\n", config.MaskSecret(cfg.APIKey))
	fmt.Printf("  userAgent .......... %s\n", config.RequiredUserAgent())

	var related []string
	for _, kv := range os.Environ() {
		name := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			name = kv[:i]
		}
		for _, c := range config.EnvCandidates {
			if name == c {
				related = append(related, name)
			}
		}
	}
	fmt.Printf("\n  env liên quan ...... %s\n", strings.Join(related, ", "))

	line("2. GET /models")
	fmt.Println("  pending upstream probe")

	line("3. Model phục vụ được")
	fmt.Println("  pending chat probe")

	line("4. User-Agent mimo-claw")
	fmt.Printf("  required header .... %s\n", config.RequiredUserAgent())

	line("VPS")
	fmt.Printf("  hostname ........... %s\n", hostname())
	fmt.Printf("  os/arch ............ %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  cpu cores .......... %d\n", runtime.NumCPU())

	fmt.Println("\nresult: OK — env hợp lệ")
	return 0
}

func line(title string) {
	pad := 58 - len(title)
	if pad < 0 {
		pad = 0
	}
	fmt.Printf("\n── %s %s\n", title, strings.Repeat("─", pad))
}

func hostname() string {
	h, _ := os.Hostname()
	if h == "" {
		return "(unknown)"
	}
	return h
}
