### Removed
- Device pairing is gone: paired devices and their list (Settings → Devices), six-digit pairing codes,
  the pairing code on the sign-in screen and in the setup guide's Connect your phone, the `ovis_device`
  cookie, device roles (watch and drive), Revoke and Revoke every device, the notice that a device
  paired, the `/api/devices` routes, the plugin's `pair` command and the herdr Phone setup action, and
  `devices.json`. The opt-in LAN HTTPS listener (`OVIS_LAN_HTTPS_PORT`, `OVIS_LAN_HTTPS_HOST`,
  `OVIS_LAN_HTTPS_CERT`, `OVIS_LAN_HTTPS_KEY`) and the LAN exposure notice are gone too, and so is the
  merge of two state directories. The shared access token (`OVIS_TOKEN`), or this PC itself, is the way
  in: with no token a request from another address, or through a proxy, is refused, and one owner may do
  everything.
- The read-only watching-device mode is gone: the "View only" item in the status bar for a device and
  the 403 `read_only` answer for a device role. The "View only while you are not typing here" view of
  a pane you do not hold stays.
- The phone apps (iOS and Android) and their push relay are gone. Install Ovis from the browser; Web
  Push alerts through the browser stay. `GET /api/health` no longer carries `lan_exposure`,
  `auth.role` or `security.pairing_gate`, and Settings → Devices and PCs → More settings → Access no
  longer shows a Pairing gate row.
