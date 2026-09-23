package main

import (
	"fmt"
	"os"

	"github.com/nhungnhu66/xkdemo/internal/demo/config"
	"github.com/nhungnhu66/xkdemo/internal/demo/vps"
	"github.com/nhungnhu66/xkdemo/internal/demo/ws"
)

func main() {
	cfg, err := config.LoadRequired()
	if err != nil {
		fmt.Fprintf(os.Stderr, "xkdemo: %v\n", err)
		os.Exit(1)
	}

	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		vps.RunDoctor(cfg)
		return
	}

	if err := ws.RunDemo(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "xkdemo: %v\n", err)
		os.Exit(1)
	}
}
