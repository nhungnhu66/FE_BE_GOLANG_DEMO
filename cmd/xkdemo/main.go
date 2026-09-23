//go:build !release

package main

import (
	"fmt"
	"os"

	"github.com/nhungnhu66/xkdemo/internal/demo/config"
	"github.com/nhungnhu66/xkdemo/internal/demo/gateway"
	"github.com/nhungnhu66/xkdemo/internal/demo/vps"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "xkdemo: %v\n", err)
		os.Exit(1)
	}

	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		os.Exit(vps.RunDoctor(cfg))
	}

	if err := gateway.Run(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "xkdemo: %v\n", err)
		os.Exit(1)
	}
}
