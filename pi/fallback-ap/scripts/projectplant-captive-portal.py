#!/usr/bin/env python3
import http.server
import socketserver
import subprocess
import urllib.parse
import os

PORT = 80
CONF_DIR = "/etc/projectplant"
STATE_DIR = "/var/lib/projectplant"
DESIRED_ENV = os.path.join(CONF_DIR, "desired_wifi.env")
APPLY_UNIT = "projectplant-apply-wifi.service"


HTML_FORM = """
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ProjectPlant Setup</title>
  <style>
  body { font-family: sans-serif; max-width: 560px; margin: 40px auto; padding: 0 12px; }
  h1 { font-size: 22px; }
  label { display:block; margin-top: 12px; }
  input[type=text], input[type=password] { width:100%; padding:8px; font-size: 16px; }
  button { margin-top: 16px; padding: 10px 14px; font-size: 16px; }
  .note { color:#555; font-size: 14px; }
  </style>
  <script>
    // Simple captive-portal redirect for some clients
    if (window.location.hostname !== "192.168.4.1") {
      // Try to force portal to our IP
      // window.location = "http://192.168.4.1/";
    }
  </script>
  </head>
<body>
  <h1>ProjectPlant Wi‑Fi Setup</h1>
  <p class="note">Enter your Wi‑Fi network name (SSID) and password. The device will connect and the setup network will turn off.</p>
  <form method="POST" action="/">
    <label>SSID
      <input name="ssid" type="text" required placeholder="Your Wi‑Fi name" />
    </label>
    <label>Password (leave empty for open networks)
      <input name="pass" type="password" />
    </label>
    <button type="submit">Apply & Connect</button>
  </form>
  <p class="note">If the setup network disappears, reconnect to your home Wi‑Fi. The device should appear on your network shortly.</p>
</body>
</html>
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML_FORM.encode("utf-8"))

    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(length).decode('utf-8', errors='ignore')
        data = urllib.parse.parse_qs(body)
        ssid = (data.get('ssid', [''])[0] or '').strip()
        psk = (data.get('pass', [''])[0] or '').strip()

        if not ssid:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing SSID")
            return

        os.makedirs(CONF_DIR, exist_ok=True)
        with open(DESIRED_ENV, 'w', encoding='utf-8') as f:
            f.write(f"SSID={ssid}\n")
            # Empty password allowed
            f.write(f"PASS={psk}\n")
            f.write("WLAN_IFACE=wlan0\n")

        # Kick off apply service (it will stop the AP target, re-enable NM and connect)
        try:
            subprocess.run(["systemctl", "start", APPLY_UNIT], check=False)
        except Exception:
            pass

        resp = (
            "<!doctype html><html><body>"
            "<h1>Applying Wi‑Fi settings...</h1>"
            "<p>You can close this page. The setup network will turn off shortly." 
            " Reconnect to your Wi‑Fi network and find the device on your LAN.</p>"
            "</body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(resp.encode("utf-8"))


if __name__ == "__main__":
    os.makedirs(STATE_DIR, exist_ok=True)
    with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass

