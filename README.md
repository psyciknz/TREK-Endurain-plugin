# Endurain Import

## What it does

A TREK trip-page plugin that lists activities from a user's self-hosted Endurain instance and imports selected activities into the currently open TREK trip.

Each imported activity becomes a TREK place at its starting coordinate, assigned to a TREK day matching the Endurain activity date. When Endurain does not include coordinates in activity details, the plugin uses the first valid point from the activity's GPS stream. The place website and notes link back to the activity in Endurain; notes also retain the activity id, sport, and description. Re-importing the same activity into the same trip is de-duplicated.

This plugin intentionally uses its own activity picker. TREK plugins cannot invoke or replace the native GPX/KML/KMZ file picker, and Endurain API keys currently only support uploads. The importer signs in with the configured Endurain username and password, then uses short-lived JWT access tokens to read activity metadata and creates native TREK places through the plugin SDK.

## Endurain setup

1. Open TREK Settings -> Plugins -> Endurain Import.
2. Enter the HTTPS URL of the Endurain instance, without `/api/v1`.
3. Enter your Endurain username and password.
4. Open a TREK trip and select the Endurain Import tab.
5. Select activities and click Import selected.

The username and password are user-scoped settings. TREK encrypts the password, and the plugin reads both only on the server. The plugin signs in using Endurain's mobile API, stores the access and rotating refresh tokens encrypted in its private database, and refreshes access tokens automatically. Credentials and tokens are never sent to the browser frame. Password-based MFA challenges and SSO-only accounts are not currently supported.

The Endurain API is expected at:

```text
GET  {endurainUrl}/api/v1/activities/user/{userId}/page_number/1/num_records/100?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&name_search=ride
GET  {endurainUrl}/api/v1/activities/{activityId}
POST {endurainUrl}/api/v1/auth/login
POST {endurainUrl}/api/v1/auth/refresh
```

The list route and filters match Endurain's authenticated activity API. The user id comes from the access token's JWT `sub` claim. Endurain API keys cannot read activities and are not used by this plugin.
```

Endurain documents bearer authentication with `Authorization: Bearer <token>` and `X-Client-Type`. The plugin sends `X-Client-Type: mobile` for read requests.

## Screenshots

The activity picker screenshot is stored in `docs/screenshot.png`.
The page styling follows the transport plugin reference in [style-guide.md](docs/style-guide.md).

## Compatibility

Supports TREK 4.x (`>=4.2.0 <5.0.0`). The plugin uses the standard trip-page frame bridge, authenticated plugin routes, user settings, and the `ctx.places`, `ctx.days`, `ctx.itinerary`, and `ctx.trips` APIs.

## Permissions

| Permission | Why |
|---|---|
| `db:own` | Store the activity-to-TREK-place de-duplication mapping in the plugin database. |
| `db:read:trips` | Read the selected trip's days and enforce membership through TREK. |
| `db:write:days` | Create a TREK day when an activity date is not already present. |
| `db:write:places` | Create a TREK place for each selected activity. |
| `db:write:itinerary` | Assign imported places to a TREK day. |
| `db:meta` | Run the plugin's private database migration. |
| `http:outbound` | Allow outbound calls to the administrator-approved Endurain host. |

The plugin declares `operatorEgress: true` because Endurain is self-hosted. After installation, an administrator must add the Endurain hostname under Admin -> Plugins -> Allowed hosts. Private or LAN Endurain hosts additionally require TREK's private egress setting.

## Setup

Install or sideload the packed plugin, activate it in Admin -> Plugins, add the Endurain hostname to Allowed hosts, and configure the three user settings before opening the plugin page.

## Development

```sh
npx trek-plugin-sdk dev
npx trek-plugin-sdk validate
npx trek-plugin-sdk pack
```

## Limitations

- The plugin imports activity metadata and starting locations, not the full GPS geometry.
- It does not currently attach or import the Endurain GPX file; use the place's Endurain link to view the activity and its route.
- Endurain must expose the documented activity list/detail routes to the configured user.
- Native TREK file import is not callable from a plugin, so GPX/FIT files are not silently routed through the native file picker.

## License

MIT
