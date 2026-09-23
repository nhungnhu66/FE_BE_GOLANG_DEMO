package gateway

import (
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nhungnhu66/xkdemo/internal/demo/config"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(*http.Request) bool { return true },
}

const listenAddr = ":8080"

func Run(cfg *config.Config) error {
	_ = cfg

	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})
	http.HandleFunc("/ws", handleWS)

	fmt.Println("ok")
	return http.ListenAndServe(listenAddr, nil)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	msg := fmt.Sprintf(
		`{"status":"demo_ok","ts":"%s"}`,
		time.Now().UTC().Format(time.RFC3339),
	)
	_ = conn.WriteMessage(websocket.TextMessage, []byte(msg))
}
