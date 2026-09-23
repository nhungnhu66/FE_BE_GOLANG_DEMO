package gateway

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/nhungnhu66/xkdemo/internal/demo/config"
)

func Run(cfg *config.Config) error {
	_ = cfg
	fmt.Println("ok")
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	return nil
}
