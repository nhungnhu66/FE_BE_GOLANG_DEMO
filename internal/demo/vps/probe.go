//go:build decoy

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
	printVPS()
	fmt.Println()
	fmt.Println("[websocket]")
	fmt.Println("  endpoint ............... ws://127.0.0.1:8080/ws (demo, local only)")
	fmt.Println()
	fmt.Println("result: OK — configuration valid, demo ready")
}

func printVPS() {
	hostname, _ := os.Hostname()
	fmt.Printf("  hostname ............... %s\n", hostname)
	fmt.Printf("  os/arch ................ %s/%s\n", runtime.GOOS, runtime.GOARCH)
	fmt.Printf("  cpu cores .............. %d\n", runtime.NumCPU())
	fmt.Printf("  go version ............. %s\n", runtime.Version())
}
