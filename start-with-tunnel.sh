#!/bin/bash
# Start 9router with Cloudflare Tunnel
# Cách dùng:
#   ./start-with-tunnel.sh          # Quick tunnel (random URL, không cần đăng nhập CF)
#   ./start-with-tunnel.sh my-domain # Named tunnel (cần cloudflared login trước)

set -e

PORT=${PORT:-20128}
TUNNEL_NAME="${1:-}"

echo "================================================"
echo "  9Router + Cloudflare Tunnel"
echo "================================================"

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "[!] cloudflared chưa được cài đặt."
    echo "    Cài đặt:"
    echo "    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared"
    echo "    chmod +x /usr/local/bin/cloudflared"
    echo ""
    echo "    Hoặc: sudo apt install cloudflared"
    echo ""
    echo "[*] Đang tự động cài cloudflared..."
    
    mkdir -p ~/.local/bin
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared
    chmod +x ~/.local/bin/cloudflared
    export PATH="$HOME/.local/bin:$PATH"
    echo "[✓] cloudflared đã cài xong"
fi

# Start 9router in background
echo "[*] Starting 9router on port $PORT..."
cd "$(dirname "$0")"
npm run dev &
ROUTER_PID=$!

# Wait for 9router to be ready
echo "[*] Waiting for 9router to be ready..."
for i in $(seq 1 60); do
    if curl -s http://localhost:$PORT/api/health > /dev/null 2>&1; then
        echo "[✓] 9router is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "[!] Timeout waiting for 9router"
        kill $ROUTER_PID 2>/dev/null
        exit 1
    fi
    sleep 2
done

# Start Cloudflare Tunnel
echo ""
echo "[*] Starting Cloudflare Tunnel..."
if [ -z "$TUNNEL_NAME" ]; then
    echo "[*] Mode: Quick Tunnel (random URL, no login required)"
    echo "[*] URL sẽ hiện bên dưới..."
    echo ""
    cloudflared tunnel --url http://localhost:$PORT
else
    echo "[*] Mode: Named Tunnel → $TUNNEL_NAME"
    echo "[*] Đảm bảo đã chạy: cloudflared tunnel login"
    cloudflared tunnel --url http://localhost:$PORT --name "$TUNNEL_NAME"
fi

# Cleanup
kill $ROUTER_PID 2>/dev/null
echo "[*] Stopped."

