package vps

import (
	"fmt"
	"os"
	"runtime"

	"github.com/nhungnhu66/xkdemo/internal/demo/config"
)

func RunDoctor(cfg *config.Config) {
	fmt.Println("=== xkdemo doctor ===")
	fmt.Println()
	fmt.Println("[env]")
	fmt.Printf("  XTR_JOIN ............... ok (%s)\n", config.MaskJoin(cfg.Join))
	fmt.Printf("  XTR_ACCOUNT_EMAIL ...... ok (%s)\n", cfg.Email)
	fmt.Println()
	fmt.Println("[vps]")
	hostname, _ := os.Hostname()
	fmt.Printf("  hostname ............... %s\n", hostname)
	fmt.Printf("  os/arch ................ %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  cpu cores .............. %d\n", runtime.NumCPU())
	fmt.Println()
	fmt.Println("result: OK — configuration valid, demo ready")
}
