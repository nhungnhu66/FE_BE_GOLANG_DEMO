package gateway

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nhungnhu66/xkdemo/internal/demo/config"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

// Run khởi động gateway: kiểm tra env rồi lắng nghe health/ws cục bộ trong lúc chờ backend.
func Run(cfg *config.Config) error {
	fmt.Println("xkdemo: gateway starting")
	fmt.Printf("xkdemo: backend .......... %s\n", cfg.GatewayURL)
	fmt.Printf("xkdemo: socket.io path ... %s\n", cfg.GatewayPath)
	fmt.Printf("xkdemo: namespace ....... /gw/mimo\n")
	fmt.Printf("xkdemo: account ......... %s\n", cfg.AccountEmail)
	fmt.Printf("xkdemo: user-agent ...... %s\n", config.RequiredUserAgent())

	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		msg := fmt.Sprintf(`{"status":"ok","email":"%s","ts":"%s"}`,
			cfg.AccountEmail, time.Now().UTC().Format(time.RFC3339))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(msg))
	})

	addr := ":8080"
	fmt.Printf("xkdemo: local health .... http://127.0.0.1%s/health\n", addr)
	fmt.Println("xkdemo: gateway ready")
	log.Printf("listening on %s", addr)
	return http.ListenAndServe(addr, nil)
}
