# Deployment

## Per-connection IB Gateway instances

`install-gateway-template.sh` installs `ibkr-gateway@.service`, the templated
unit that runs one IB Gateway per broker connection. Its instance name is the
connection id, and everything that instance touches lives under
`GATEWAY_INSTANCE_ROOT/<connection id>/`:

| Path | Purpose |
| --- | --- |
| `config.ini` | IBC settings for this connection, `0600` — holds its IBKR login |
| `gatewaystart.sh` | IBC's launcher, header rewritten to point at the files above |
| `settings/` | TWS settings, private to this instance |
| `<GATEWAY_LOG_ROOT>/<connection id>/` | IBC logs, read by the login poller |

The launcher is copied and rewritten rather than driven by environment
variables: IBC's stock `gatewaystart.sh` **assigns** `IBC_INI` near the top of
the file, so an `IBC_INI` inherited from the unit is silently ignored and every
instance would read the same config — and the same credentials.

A gateway adopted from a pre-tenancy installation keeps its own config path and
its own unit (`managed: false` on the connection). Provisioning never rewrites
it and removing the connection never deletes its files.

## Host prerequisites

* IBC installed, with `gatewaystart.sh` beside the config named by
  `GATEWAY_TEMPLATE_CONFIG`.
* IB Gateway installed at `${TWS_PATH}/ibgateway/<version>/`. IBC requires that
  exact versioned layout and will otherwise fall back to the TWS layout and
  demand a `tws.vmoptions` that does not exist.
* `xvfb-run` available. Do not guard Xvfb with `pgrep -f "Xvfb :N"` — that
  matches the guard's own command line and always reports it as running.
* The API and worker run as a user that may write the instance root and run
  `systemctl`, or provisioning is disabled with
  `GATEWAY_PROVISIONING_ENABLED=false` and connections are registered against
  paths and units an operator created.
