---
aliases:
  - ../../../http_api/playlist/ # /docs/grafana/next/http_api/playlist/
  - ../../../developers/http_api/playlist/ # /docs/grafana/next/developers/http_api/playlist/
canonical: https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/playlist/
description: Playlist Admin HTTP API
keywords:
  - grafana
  - http
  - documentation
  - api
  - playlist
labels:
  products:
    - enterprise
    - oss
    - cloud
title: 'Playlist HTTP API '
weight: 100
---

# Playlist API

{{< admonition type="note" >}}
Available in Grafana 12 and later.

This API complies with the new Grafana API structure. To learn more refer to documentation about the [API structure in Grafana](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developer-resources/api-reference/http-api/apis).

**This document may not contain the latest version of the API. For the most up-to-date list of available endpoints, refer to [playlist.grafana.app/v1](https://play.grafana.org/swagger?api=playlist.grafana.app-v1) in Swagger.**

{{< /admonition >}}

## List Playlists

`GET /apis/playlist.grafana.app/v1/namespaces/:namespace/playlists`

Lists all playlists in the specified namespace.

- `namespace`: To learn more about which namespace to use, refer to the [API overview](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developers/http_api/apis/).

**Example Request**:

```http
GET /apis/playlist.grafana.app/v1/namespaces/default/playlists HTTP/1.1
Accept: application/json
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>
```

**Example Response**:

```http
HTTP/1.1 200
Content-Type: application/json

{
  "kind": "PlaylistList",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {},
  "items": [
    {
      "kind": "Playlist",
      "apiVersion": "playlist.grafana.app/v1",
      "metadata": {
        "name": "my-playlist-uid",
        "namespace": "default",
        "resourceVersion": "1234567890",
        "creationTimestamp": "2024-01-15T10:30:00Z"
      },
      "spec": {
        "title": "My Playlist",
        "interval": "5m",
        "items": [
          {
            "type": "dashboard_by_uid",
            "value": "dashboard-uid-1",
            "variables": {
              "host": ["Host1"],
              "datacenter": ["eu-west-1", "us-east-1"]
            }
          },
          {
            "type": "dashboard_by_tag",
            "value": "important"
          }
        ]
      }
    }
  ]
}
```

## Get a Playlist

`GET /apis/playlist.grafana.app/v1/namespaces/:namespace/playlists/:name`

Retrieves a specific playlist by name.

- `namespace`: To learn more about which namespace to use, refer to the [API overview](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developers/http_api/apis/).
- `name`: The UID of the playlist.

**Example Request**:

```http
GET /apis/playlist.grafana.app/v1/namespaces/default/playlists/my-playlist-uid HTTP/1.1
Accept: application/json
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>
```

**Example Response**:

```http
HTTP/1.1 200
Content-Type: application/json

{
  "kind": "Playlist",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {
    "name": "my-playlist-uid",
    "namespace": "default",
    "resourceVersion": "1234567890",
    "creationTimestamp": "2024-01-15T10:30:00Z"
  },
  "spec": {
    "title": "My Playlist",
    "interval": "5m",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-1"
      },
      {
        "type": "dashboard_by_tag",
        "value": "important"
      }
    ]
  }
}
```

## Create a Playlist

`POST /apis/playlist.grafana.app/v1/namespaces/:namespace/playlists`

Creates a new playlist.

- `namespace`: To learn more about which namespace to use, refer to the [API overview](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developers/http_api/apis/).

**Example Request**:

```http
POST /apis/playlist.grafana.app/v1/namespaces/default/playlists HTTP/1.1
Accept: application/json
Content-Type: application/json
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>

{
  "kind": "Playlist",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {
    "name": "my-new-playlist-uid"
  },
  "spec": {
    "title": "My New Playlist",
    "interval": "5m",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-1"
      },
      {
        "type": "dashboard_by_tag",
        "value": "monitoring"
      }
    ]
  }
}
```

**Example Response**:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "kind": "Playlist",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {
    "name": "my-new-playlist-uid",
    "namespace": "default",
    "resourceVersion": "1234567891",
    "creationTimestamp": "2024-01-15T10:35:00Z"
  },
  "spec": {
    "title": "My New Playlist",
    "interval": "5m",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-1"
      },
      {
        "type": "dashboard_by_tag",
        "value": "monitoring"
      }
    ]
  }
}
```

## Update a Playlist

`PUT /apis/playlist.grafana.app/v1/namespaces/:namespace/playlists/:name`

Updates an existing playlist. The entire playlist spec must be provided.

- `namespace`: To learn more about which namespace to use, refer to the [API overview](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developers/http_api/apis/).
- `name`: The UID of the playlist.

**Example Request**:

```http
PUT /apis/playlist.grafana.app/v1/namespaces/default/playlists/my-playlist-uid HTTP/1.1
Accept: application/json
Content-Type: application/json
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>

{
  "kind": "Playlist",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {
    "name": "my-playlist-uid",
    "namespace": "default",
    "resourceVersion": "1234567890"
  },
  "spec": {
    "title": "My Updated Playlist",
    "interval": "10m",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-1"
      },
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-2"
      },
      {
        "type": "dashboard_by_tag",
        "value": "updated-tag"
      }
    ]
  }
}
```

**Example Response**:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "kind": "Playlist",
  "apiVersion": "playlist.grafana.app/v1",
  "metadata": {
    "name": "my-playlist-uid",
    "namespace": "default",
    "resourceVersion": "1234567892",
    "creationTimestamp": "2024-01-15T10:30:00Z"
  },
  "spec": {
    "title": "My Updated Playlist",
    "interval": "10m",
    "items": [
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-1"
      },
      {
        "type": "dashboard_by_uid",
        "value": "dashboard-uid-2"
      },
      {
        "type": "dashboard_by_tag",
        "value": "updated-tag"
      }
    ]
  }
}
```

## Delete a Playlist

`DELETE /apis/playlist.grafana.app/v1/namespaces/:namespace/playlists/:name`

Deletes a playlist.

- `namespace`: To learn more about which namespace to use, refer to the [API overview](https://grafana.com/docs/grafana/<GRAFANA_VERSION>/developers/http_api/apis/).
- `name`: The UID of the playlist.

**Example Request**:

```http
DELETE /apis/playlist.grafana.app/v1/namespaces/default/playlists/my-playlist-uid HTTP/1.1
Accept: application/json
Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>
```

**Example Response**:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "kind": "Status",
  "apiVersion": "v1",
  "metadata": {},
  "status": "Success",
  "code": 200
}
```

## Playlist Item Types

Playlist items support three types:

- `dashboard_by_uid`: Include a specific dashboard by its UID
- `dashboard_by_tag`: Include all dashboards with a specific tag
- `dashboard_by_id`: (Deprecated) Include a dashboard by internal ID

Items of type `dashboard_by_uid` also support an optional `variables` field. Each key is a template variable name. Each value is a list of one or more strings. Grafana applies them when the playlist reaches that item. List several values under one name for a multi-value variable. Omit the field to leave the item's behavior unchanged. Add the same dashboard UID more than once with a different set of variables to rotate one dashboard through each set.

The API sets no maximum on the number of variables an item carries, the number of values under one name, or the length of a variable name or value. The Grafana playlist editor and playlist playback apply their own limits in the browser: at most 32 variables for each item, at most 64 values for each variable, at most 128 Unicode code points for a variable name, at most 1024 Unicode code points for a value, and at most 8192 characters of encoded `var-` parameters in one dashboard URL. An item whose stored variables exceed the variable, value, or length limits still plays, but playback applies only the variables that stay within them, and the playlist editor shows a message in place of that item's variable controls, so remove the item and add it again to change its variables. When an item's variables exceed the URL limit, playback skips the pairs that don't fit and applies the rest of the item.
