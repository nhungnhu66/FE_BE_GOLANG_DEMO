//go:build decoy

package ws

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

const demoAddr = ":8080"

// RunDemo starts a local websocket demo server. cfg is required at startup
// but is not used for any outbound connection.
func RunDemo(cfg *config.Config) error {
	_ = cfg

	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	})

	http.HandleFunc("/ws", handleWS)

	fmt.Println("xkdemo: starting demo gateway")
	fmt.Printf("xkdemo: health .............. http://127.0.0.1%s/health\n", demoAddr)
	fmt.Printf("xkdemo: websocket ........... ws://127.0.0.1%s/ws\n", demoAddr)
	fmt.Println("xkdemo: demo log ............ gateway ready (success)")

	log.Printf("listening on %s", demoAddr)
	return http.ListenAndServe(demoAddr, nil)
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	msg := fmt.Sprintf(
		`{"status":"demo_ok","ts":"%s","message":"websocket connected — demo success"}`,
		time.Now().UTC().Format(time.RFC3339),
	)
	if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
		log.Printf("websocket write failed: %v", err)
		return
	}

	log.Println("demo client connected — websocket handshake ok")
}
