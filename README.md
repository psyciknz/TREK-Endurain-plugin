# Endurain Import

## What it does

A TREK trip-page plugin that lists activities from a user's self-hosted Endurain instance and imports selected activities into the currently open TREK trip.

Each imported activity becomes a TREK place at the activity's starting coordinate, assigned to a TREK day matching the Endurain activity date. The place notes retain the Endurain activity id, sport, and description. Re-importing the same activity into the same trip is de-duplicated.

This plugin intentionally uses its own activity picker. TREK plugins cannot invoke or replace the native GPX/KML/KMZ file picker, and Endurain's current API-key scope only supports uploads. The importer therefore uses an Endurain bearer access token to read activity metadata and creates native TREK places through the plugin SDK.

## Endurain setup

1. Open TREK Settings -> Plugins -> Endurain Import.
2. Enter the HTTPS URL of the Endurain instance, without `/api/v1`.
3. Enter an Endurain bearer access token with access to activities.
4. Open a TREK trip and select the Endurain Import tab.
5. Select activities and click Import selected.

The access token is a user-scoped secret setting. It is read only by the server route and is never sent to the browser frame.

The Endurain API is expected at:

```text
GET  {endurainUrl}/api/v1/activities/user/{userId}/page_number/1/num_records/100?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&name_search=ride
GET  {endurainUrl}/api/v1/activities/{activityId}

The list route and filters match Endurain's authenticated activity API. The user id is read from the access token's JWT `sub` claim; the token is never logged or sent to the browser.
```

Endurain documents bearer authentication with `Authorization: Bearer <token>` and `X-Client-Type`. The plugin sends `X-Client-Type: mobile` for read requests.

## Screenshots

The activity picker screenshot is stored in `docs/screenshot.png`.

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

Install or sideload the packed plugin, activate it in Admin -> Plugins, add the Endurain hostname to Allowed hosts, and configure the two user settings before opening the plugin page.

## Development

```sh
npx trek-plugin-sdk dev
npx trek-plugin-sdk validate
npx trek-plugin-sdk pack
```

## Limitations

- The plugin imports activity metadata and starting locations, not the full GPS geometry.
- Endurain must expose the documented activity list/detail routes to the configured user.
- Native TREK file import is not callable from a plugin, so GPX/FIT files are not silently routed through the native file picker.

## License

MIT
