---
name: truescrape
description: Use when a task needs public social media or creator data. Triggers on "scrape this profile", "get the transcript", "pull their recent videos", "what ads is X running", "track this creator", "social media data", "creator data", or any request for data from YouTube, TikTok, Instagram, Twitter/X, Facebook and the Meta Ad Library, LinkedIn, Reddit, Threads, Bluesky, Pinterest, Twitch, Spotify, GitHub, link-in-bio pages and more. Covers endpoint selection, credit costs, batching many targets, change subscriptions and caching for the TrueScrape API, its CLI and its MCP server.
---

# TrueScrape

One API key, one response shape, one field vocabulary across every platform
in the catalogue. This skill teaches how to pick an endpoint and how billing
works, so you plan calls well instead of discovering the rules through errors.

Three ways in, all serving the same endpoints with the same billing:

- **HTTP**: `GET https://api.truescrape.com/v1/<platform>/<action>?...`
- **CLI**: `npx truescrape <platform> <action> --flag value`
- **MCP**: `POST https://api.truescrape.com/mcp`, discoverable at `/.well-known/mcp`

**Auth:** the header `x-api-key: $TRUESCRAPE_API_KEY` on every request. Keys
are at https://truescrape.com/dashboard.
**Base URL:** `TRUESCRAPE_BASE_URL`, default `https://api.truescrape.com`.
The CLI reads both variables; `truescrape auth login` stores a key instead.

## The three rules that change how you plan

**1. Failed requests and empty results are never charged.** Do not write
defensive logic to avoid wasting credits on a target that might be private or
gone. Call it; if it fails or comes back empty, it cost nothing.

**2. Cache hits cost 0 credits.** Add `cache_max_age` whenever real-time data
is not required. This is the biggest lever on cost:

```
?handle=@mkbhd&cache_max_age=7d     # free if fetched in the last 7 days
```

Durations are written `30m`, `12h`, `7d`. Use `1h` for engagement metrics,
`24h` for profiles, `7d` or more for transcripts, which never change.
`meta.cached` and `meta.cacheAgeSeconds` say whether a hit was served.

**3. Never loop over more than a handful of targets.** Use a batch job.
500 profiles is one request, not 500, and a batch has no timeout ceiling.

## Choosing an endpoint

Read the **Endpoint catalogue** at the end of this file first. It lists every
endpoint with its path, its CLI command, its credit cost and what it returns,
grouped by platform, and it is generated from the live API. If the task names
a platform or an action the table does not cover, check the live sources
before assuming it is unsupported:

- `GET https://api.truescrape.com/llms.txt`: every endpoint with its cost and cache policy, in plain text
- `GET https://api.truescrape.com/openapi.json`: the same, typed; every operation carries `x-credit-cost`
- `npx truescrape list` or `npx truescrape list youtube`: the same catalogue from the terminal, no network needed

Identifier params are forgiving. `handle` accepts `@name`, a platform id or a
full URL; `url` accepts a full URL or the bare id where the platform has one,
such as an 11-character YouTube video id.

Endpoints marked *(experimental)* in the catalogue may change shape. Read
`data` defensively there.

## Every response has the same shape

```jsonc
{
  "success": true,
  "data": { /* unified schema: the same field names on every platform */ },
  "meta": {
    "creditsCharged": 1,
    "cached": false,
    "cacheAgeSeconds": null,
    "durationMs": 412,
    "requestId": "req_..."
  },
  "pagination": { "cursor": "...", "hasMore": true, "count": 30 }   // list endpoints only
}
```

A `Creator` has `followerCount` whether it came from YouTube subscribers or
Instagram followers. A `Post` has `viewCount`, `likeCount` and `publishedAt`
everywhere. **Write your parsing once.**

`null` means the platform does not expose that field publicly. It never means
zero. Do not conflate the two, and do not retry hoping for a value.

Pass `pagination.cursor` back as `cursor` to get the next page while `hasMore`
is true. The CLI does this for you with `--all --max-pages <n>`.

Add `include_raw=true` to also receive the untouched upstream payload under
`raw`, for anything the unified schema does not carry.

Errors have one shape too:

```json
{ "success": false, "error": { "code": "upstream_not_found", "message": "...", "details": {} } }
```

## Many targets: batch, not a loop

```bash
curl -X POST "https://api.truescrape.com/v1/jobs/batch" \
  -H "x-api-key: $TRUESCRAPE_API_KEY" -H 'content-type: application/json' \
  -d '{
    "endpoint": "youtube.channel",
    "targets": [{"handle":"@mkbhd"},{"handle":"@mrbeast"}],
    "webhook_url": "https://you.example/hook"
  }'
```

Returns `202` with a `jobId`. Poll `GET /v1/jobs/{jobId}` or wait for the
webhook. Up to 500 targets per job, no timeout ceiling, and the result lists
every target with its own outcome. Targets that failed or came back empty are
not billed.

CLI: `npx truescrape batch youtube channel --targets targets.json --wait`.

Endpoint names in job payloads use **dots** (`youtube.channel`). MCP tool
names use **underscores** (`youtube_channel`). Same endpoint, same cost.

## Recurring monitoring: subscribe, do not poll

```bash
curl -X POST "https://api.truescrape.com/v1/subscriptions" \
  -H "x-api-key: $TRUESCRAPE_API_KEY" -H 'content-type: application/json' \
  -d '{
    "endpoint": "youtube.channel",
    "params": {"handle":"@mkbhd"},
    "webhook_url": "https://you.example/hook",
    "interval_seconds": 3600
  }'
```

A subscription re-checks on the interval and calls the webhook when the data
changes. **Unchanged checks are free; you are billed only when something
actually changed.** When a user asks to "track", "watch" or "monitor"
something, this is the tool, not a timer loop over the sync endpoints.

## Errors, from your side

| Code | HTTP | What it means for you |
|---|---|---|
| `missing_api_key`, `invalid_api_key` | 401 | Fix the key. **Never a billing problem.** |
| `insufficient_credits` | 402 | The key is valid; the balance is not. Top up at the dashboard. |
| `not_configured` | 501 | The service cannot serve this endpoint right now; the message says why. Surface it, do not retry. |
| `upstream_not_found` | 404 | The target is private or gone. Do not retry. |
| `upstream_blocked`, `upstream_rate_limited` | 502 / 429 | Transient. Retry with backoff. |
| `empty_result` | 200 | Genuinely nothing there. `data` is empty and the call cost nothing. |
| `daily_cap_exceeded` | 429 | Your account's own daily spend cap. Do not retry today. |

**None of these are charged.** Do not add credit-preserving logic around
them; it only adds latency.

## Checking spend

```
GET /v1/account/credit-balance      balance, spent today, daily cap
GET /v1/account/usage-forecast      burn rate and estimated days remaining
GET /v1/account/most-used-routes    per-endpoint spend and cache hit rate
```

CLI: `npx truescrape balance`. Run it before a large batch.

To estimate a job before running it: take each endpoint's cost from the
catalogue below (or `x-credit-cost` in `/openapi.json`), multiply by the number
of targets, and count cache hits, failures and empties as 0.

## Worked examples

**"Get me the transcript of this video and summarise it"**

```
GET /v1/youtube/transcript?url=<url>&cache_max_age=30d
npx truescrape youtube transcript --url <url> --cache-max-age 30d
```

Transcripts never change, so cache aggressively. `data.text` is the whole
transcript; `data.cues` carries timestamps. A video with no captions returns
`empty_result` and costs nothing. Do not retry it.

**"What has MrBeast posted recently and how did it do?"**

```
GET /v1/youtube/channel-videos?handle=@mrbeast&cache_max_age=1h
npx truescrape youtube channel-videos --handle @mrbeast --cache-max-age 1h
```

One call returns the recent uploads with view counts. Do not then call
`/v1/youtube/video` on each one; you already have what you need unless exact
publish dates or like counts are required. `tab=shorts` or `tab=streams`
switches the list.

**"Track these 50 creators and tell me when they post"**

50 subscriptions to `youtube.channelVideos` (or the platform's equivalent),
one per creator, all pointing at your webhook. Not a timer loop. Unchanged
checks are free, so the interval can be short.

**"Pull transcripts for every video on this channel"**

```
1. GET  /v1/youtube/channel-videos?handle=@x                  collect the video ids
2. POST /v1/jobs/batch  { "endpoint": "youtube.transcript",
                          "targets": [{"url":"<id>"}, ...] }    all of them in one job
```

Never loop step 2.

**"What ads is Nike running?"**

```
GET /v1/facebook/ad-library/search?query=nike&country=US
npx truescrape facebook ad-library-search --query nike --country US
```

For one advertiser's complete list use `/v1/facebook/ad-library/page-ads`
with its `page_id`; `/v1/facebook/ad-library/advertisers?query=nike` finds the
id. Google's ad transparency data is under `/v1/google/ad-library/` and
LinkedIn's under `/v1/linkedin/ads/search`.

## Endpoint catalogue

<!-- catalogue:start -->
206 endpoints across 37 platforms, generated from the live API on 2026-09-05.

### amazon (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/amazon/offers` | `truescrape amazon offers --asin` | 3 | All seller offers for a product |
| `GET /v1/amazon/product` | `truescrape amazon product --asin` | 3 | Product details |
| `GET /v1/amazon/search` | `truescrape amazon search --query` | 3 | Search results |
| `GET /v1/amazon/shop` | `truescrape amazon shop --url` | 1 | Amazon Shop page |

### apple-music (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/apple-music/album` | `truescrape apple-music album --id` | 1 | Album details |
| `GET /v1/apple-music/artist` | `truescrape apple-music artist --id` | 1 | Artist details |
| `GET /v1/apple-music/search` | `truescrape apple-music search --query` | 1 | Search |
| `GET /v1/apple-music/track` | `truescrape apple-music track --id` | 1 | Track details |

### bluesky (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/bluesky/post` | `truescrape bluesky post --url` | 1 | Post |
| `GET /v1/bluesky/profile` | `truescrape bluesky profile --handle` | 1 | Profile |
| `GET /v1/bluesky/user/posts` | `truescrape bluesky user-posts --handle` | 1 | User posts |

### ebay (2)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/ebay/product` | `truescrape ebay product` | 1 | eBay listing details (experimental) |
| `GET /v1/ebay/search` | `truescrape ebay search --query` | 1 | Search eBay listings (experimental) |

### facebook (22)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/facebook/ad-library/ad` | `truescrape facebook ad-library-ad --id` | 1 | Ad details |
| `GET /v1/facebook/ad-library/ad-transcript` | `truescrape facebook ad-library-ad-transcript` | 1 | Ad video transcript (experimental) |
| `GET /v1/facebook/ad-library/advertisers` | `truescrape facebook ad-library-advertisers --query` | 1 | Find advertisers running ads |
| `GET /v1/facebook/ad-library/page-ads` | `truescrape facebook ad-library-page-ads --page-id` | 2 | All ads for one advertiser |
| `GET /v1/facebook/ad-library/search` | `truescrape facebook ad-library-search --query` | 2 | Search the Meta Ad Library |
| `GET /v1/facebook/city-events` | `truescrape facebook city-events --url` | 1 | Get the events of a city (experimental) |
| `GET /v1/facebook/comment-replies` | `truescrape facebook comment-replies --url --comment-id` | 1 | Replies to a comment |
| `GET /v1/facebook/event` | `truescrape facebook event --url` | 1 | Event details |
| `GET /v1/facebook/events/search` | `truescrape facebook events-search --query` | 1 | Search public events |
| `GET /v1/facebook/group` | `truescrape facebook group --url` | 1 | Public group info |
| `GET /v1/facebook/group-posts` | `truescrape facebook group-posts --url` | 1 | Public group posts |
| `GET /v1/facebook/marketplace/item` | `truescrape facebook marketplace-item --url` | 1 | Marketplace listing details |
| `GET /v1/facebook/marketplace/locations` | `truescrape facebook marketplace-locations --query` | 1 | Find a Marketplace location |
| `GET /v1/facebook/marketplace/search` | `truescrape facebook marketplace-search --query` | 1 | Search Marketplace listings |
| `GET /v1/facebook/page-posts` | `truescrape facebook page-posts --url` | 1 | Public Page posts |
| `GET /v1/facebook/page-reels` | `truescrape facebook page-reels --url` | 1 | Public Page videos and reels |
| `GET /v1/facebook/post` | `truescrape facebook post --url` | 1 | Single post, video, or reel |
| `GET /v1/facebook/post-comments` | `truescrape facebook post-comments --url` | 1 | Comments on a post |
| `GET /v1/facebook/post-transcript` | `truescrape facebook post-transcript --url` | 1 | Video transcript |
| `GET /v1/facebook/profile` | `truescrape facebook profile --url` | 1 | Public Page profile |
| `GET /v1/facebook/profile-events` | `truescrape facebook profile-events --url` | 1 | Events on a Page |
| `GET /v1/facebook/profile-photos` | `truescrape facebook profile-photos --url` | 1 | Photos on a Page |

### github (10)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/github/repository` | `truescrape github repository --url` | 1 | Repository details |
| `GET /v1/github/trending/developers` | `truescrape github trending-developers` | 1 | Trending developers |
| `GET /v1/github/trending/repositories` | `truescrape github trending-repositories` | 1 | Trending repositories |
| `GET /v1/github/user` | `truescrape github user` | 1 | User or organisation profile |
| `GET /v1/github/user/activity` | `truescrape github user-activity` | 1 | Public activity |
| `GET /v1/github/user/contributions` | `truescrape github user-contributions` | 1 | Contributions calendar |
| `GET /v1/github/user/followers` | `truescrape github user-followers` | 1 | Followers |
| `GET /v1/github/user/following` | `truescrape github user-following` | 1 | Following |
| `GET /v1/github/user/pull-requests` | `truescrape github user-pull-requests --handle` | 1 | Pull requests by a user |
| `GET /v1/github/user/repositories` | `truescrape github user-repositories` | 1 | User repositories |

### google (8)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/google/ad-library/ad` | `truescrape google ad-library-ad --url` | 1 | Ad details |
| `GET /v1/google/ad-library/advertiser-ads` | `truescrape google ad-library-advertiser-ads` | 2 | Ads run by an advertiser or domain |
| `GET /v1/google/ad-library/advertisers` | `truescrape google ad-library-advertisers --query` | 1 | Find advertisers in the Ads Transparency Centre |
| `GET /v1/google/jobs` | `truescrape google jobs --query` | 5 | Google Jobs results |
| `GET /v1/google/maps-search` | `truescrape google maps-search --query --latitude --longitude` | 5 | Google Maps place search |
| `GET /v1/google/news` | `truescrape google news --query` | 5 | Google News results |
| `GET /v1/google/search` | `truescrape google search --query` | 1 | Web search results |
| `GET /v1/google/shopping` | `truescrape google shopping --query` | 5 | Google Shopping results |

### identity (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/find-social-profiles` | `truescrape identity find-social-profiles --platform --handle` | 10 | Find a creator's other social profiles (experimental) |

### inference (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/detect-age-gender` | `truescrape inference age-gender --url` | 1 | Estimate age and gender from an image (experimental) |

### instagram (19)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/instagram/audio-reels` | `truescrape instagram audio-reels --audio-id` | 1 | Reels using a sound (experimental) |
| `GET /v1/instagram/comment-replies` | `truescrape instagram comment-replies --url --comment-id` | 1 | Replies under one comment (experimental) |
| `GET /v1/instagram/hashtag-posts` | `truescrape instagram hashtag-posts --hashtag` | 1 | Posts under a hashtag (experimental) |
| `GET /v1/instagram/highlight` | `truescrape instagram highlight --id` | 1 | Stories inside a highlight (experimental) |
| `GET /v1/instagram/popular-search` | `truescrape instagram popular-search --query` | 1 | Top posts for a keyword (experimental) |
| `GET /v1/instagram/post` | `truescrape instagram post --url` | 1 | Post or reel details (experimental) |
| `GET /v1/instagram/post-comments` | `truescrape instagram post-comments --url` | 1 | Comments on a post or reel (experimental) |
| `GET /v1/instagram/profile` | `truescrape instagram profile --handle` | 1 | Profile details (experimental) |
| `GET /v1/instagram/profile-post-count` | `truescrape instagram profile-post-count --handle` | 1 | Post count for a profile (experimental) |
| `GET /v1/instagram/profile-search` | `truescrape instagram profile-search --query` | 1 | Search accounts (experimental) |
| `GET /v1/instagram/reels-search` | `truescrape instagram reels-search --query` | 1 | Search reels by keyword (experimental) |
| `GET /v1/instagram/search` | `truescrape instagram search --query` | 1 | Search accounts, hashtags and places (experimental) |
| `GET /v1/instagram/transcript` | `truescrape instagram transcript --url` | 1 | Reel or video transcript (experimental) |
| `GET /v1/instagram/trending-reels` | `truescrape instagram trending-reels` | 1 | Reels trending on Explore (experimental) |
| `GET /v1/instagram/user-embed` | `truescrape instagram user-embed --handle` | 1 | Profile via the public embed card (experimental) |
| `GET /v1/instagram/user-highlights` | `truescrape instagram user-highlights` | 1 | Story highlight covers (experimental) |
| `GET /v1/instagram/user-posts` | `truescrape instagram user-posts --handle` | 1 | Posts and reels from a profile (experimental) |
| `GET /v1/instagram/user-reels` | `truescrape instagram user-reels` | 1 | Reels from a profile (experimental) |
| `GET /v1/instagram/user-tagged-posts` | `truescrape instagram user-tagged-posts` | 1 | Posts a profile is tagged in (experimental) |

### kick (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/kick/clip` | `truescrape kick clip --url` | 1 | Clip |

### komi (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/komi` | `truescrape komi page --url` | 1 | Komi page |

### kwai (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/kwai/post` | `truescrape kwai post --url` | 1 | Post |
| `GET /v1/kwai/profile` | `truescrape kwai profile --handle` | 1 | Profile |
| `GET /v1/kwai/user/posts` | `truescrape kwai user-posts --handle` | 1 | User posts |

### linkbio (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/linkbio` | `truescrape linkbio page --url` | 1 | Lnk.Bio page |

### linkedin (8)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/linkedin/ad` | `truescrape linkedin ad --url` | 1 | Ad details |
| `GET /v1/linkedin/ads/search` | `truescrape linkedin ads-search` | 1 | Search ads |
| `GET /v1/linkedin/company` | `truescrape linkedin company --url` | 1 | Company page |
| `GET /v1/linkedin/company/posts` | `truescrape linkedin company-posts --url` | 1 | Company posts |
| `GET /v1/linkedin/post` | `truescrape linkedin post --url` | 1 | Post details |
| `GET /v1/linkedin/post/transcript` | `truescrape linkedin post-transcript --url` | 1 | Post transcript (experimental) |
| `GET /v1/linkedin/profile` | `truescrape linkedin profile --url` | 1 | Person's profile |
| `GET /v1/linkedin/search/posts` | `truescrape linkedin search-posts --query` | 1 | Search posts (experimental) |

### linkme (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/linkme` | `truescrape linkme page --url` | 1 | LinkMe page |

### linktree (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/linktree` | `truescrape linktree page --url` | 1 | Linktree page |

### milkshake (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/milkshake` | `truescrape milkshake page --url` | 1 | Milkshake page |

### pillar (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/pillar` | `truescrape pillar page --url` | 1 | Pillar page |

### pinterest (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/pinterest/board` | `truescrape pinterest board --url` | 1 | Board and its pins |
| `GET /v1/pinterest/pin` | `truescrape pinterest pin --url` | 1 | Pin details |
| `GET /v1/pinterest/search` | `truescrape pinterest search --query` | 1 | Search pins |
| `GET /v1/pinterest/user/boards` | `truescrape pinterest user-boards --handle` | 1 | Boards owned by a user |

### reddit (9)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/reddit/post` | `truescrape reddit post --url` | 1 | Post details |
| `GET /v1/reddit/post/comment/replies` | `truescrape reddit post-comment-replies --url` | 1 | Comment replies |
| `GET /v1/reddit/post/comments` | `truescrape reddit post-comments --url` | 1 | Post comments |
| `GET /v1/reddit/post/transcript` | `truescrape reddit post-transcript --url` | 1 | Video transcript (experimental) |
| `GET /v1/reddit/search` | `truescrape reddit search --query` | 1 | Search posts |
| `GET /v1/reddit/subreddit` | `truescrape reddit subreddit --subreddit` | 1 | Subreddit posts |
| `GET /v1/reddit/subreddit/details` | `truescrape reddit subreddit-details --subreddit` | 1 | Subreddit details |
| `GET /v1/reddit/user` | `truescrape reddit user --username` | 1 | User profile |
| `GET /v1/reddit/user/posts` | `truescrape reddit user-posts --username` | 1 | User posts |

### redfin (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/redfin/agent` | `truescrape redfin agent --url` | 1 | Real estate agent profile |
| `GET /v1/redfin/for-rent` | `truescrape redfin for-rent --url` | 1 | For-rent property details |
| `GET /v1/redfin/for-sale` | `truescrape redfin for-sale --url` | 1 | For-sale property details |
| `GET /v1/redfin/search` | `truescrape redfin search --url` | 1 | Search Redfin listing results |

### rumble (5)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/rumble/channel/videos` | `truescrape rumble channel-videos --handle` | 1 | Channel videos |
| `GET /v1/rumble/search` | `truescrape rumble search --query` | 1 | Search videos |
| `GET /v1/rumble/video` | `truescrape rumble video --url` | 1 | Video details |
| `GET /v1/rumble/video/comments` | `truescrape rumble video-comments --url` | 1 | Video comments |
| `GET /v1/rumble/video/transcript` | `truescrape rumble video-transcript --url` | 1 | Video transcript |

### snapchat (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/snapchat/profile` | `truescrape snapchat profile --handle` | 1 | User profile |
| `GET /v1/snapchat/spotlight` | `truescrape snapchat spotlight --url` | 1 | Spotlight by link |
| `GET /v1/snapchat/spotlight/comments` | `truescrape snapchat spotlight-comments --url` | 1 | Spotlight comments by link |

### solo (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/solo` | `truescrape solo page --url` | 1 | Solo page |

### soundcloud (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/soundcloud/artist` | `truescrape soundcloud artist --handle` | 1 | Artist profile |
| `GET /v1/soundcloud/artist/tracks` | `truescrape soundcloud artist-tracks --handle` | 1 | Artist tracks |
| `GET /v1/soundcloud/track` | `truescrape soundcloud track --url` | 1 | Track details |

### spotify (7)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/spotify/album` | `truescrape spotify album --id` | 1 | Album details |
| `GET /v1/spotify/artist` | `truescrape spotify artist --id` | 1 | Artist details |
| `GET /v1/spotify/playlist` | `truescrape spotify playlist` | 1 | Playlist contents (experimental) |
| `GET /v1/spotify/podcast` | `truescrape spotify podcast --id` | 1 | Podcast details |
| `GET /v1/spotify/podcast/episodes` | `truescrape spotify podcast-episodes --id` | 1 | Podcast episodes |
| `GET /v1/spotify/search` | `truescrape spotify search --query` | 1 | Search |
| `GET /v1/spotify/track` | `truescrape spotify track --id` | 1 | Track details |

### taplink (1)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/taplink` | `truescrape taplink page --url` | 1 | Taplink page |

### telegram (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/telegram/channel` | `truescrape telegram channel --handle` | 1 | Channel (experimental) |
| `GET /v1/telegram/channel-posts` | `truescrape telegram channel-posts --handle` | 1 | Channel posts (experimental) |
| `GET /v1/telegram/post` | `truescrape telegram post --url` | 1 | Post (experimental) |

### threads (5)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/threads/post` | `truescrape threads post --url` | 1 | Post |
| `GET /v1/threads/profile` | `truescrape threads profile --handle` | 1 | Profile |
| `GET /v1/threads/search` | `truescrape threads search --query` | 1 | Search posts by keyword |
| `GET /v1/threads/search/users` | `truescrape threads search-users --query` | 1 | Search users |
| `GET /v1/threads/user/posts` | `truescrape threads user-posts --handle` | 1 | User posts |

### tiktok (32)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/tiktok/ad-library/ad` | `truescrape tiktok ad-library-ad --ad-id` | 1 | One TikTok ad (experimental) |
| `GET /v1/tiktok/ad-library/search` | `truescrape tiktok ad-library-search --region` | 1 | Search the TikTok Ads Library (experimental) |
| `GET /v1/tiktok/collection/videos` | `truescrape tiktok collection-videos` | 1 | Collection videos (experimental) |
| `GET /v1/tiktok/comment-replies` | `truescrape tiktok comment-replies --comment-id --url` | 1 | Replies to a comment (experimental) |
| `GET /v1/tiktok/comments` | `truescrape tiktok comments --url` | 1 | Comments on a video (experimental) |
| `GET /v1/tiktok/creators/popular` | `truescrape tiktok creators-popular` | 1 | Popular creators (experimental) |
| `GET /v1/tiktok/followers` | `truescrape tiktok followers --handle` | 1 | Accounts following a creator (experimental) |
| `GET /v1/tiktok/following` | `truescrape tiktok following --handle` | 1 | Accounts a creator follows (experimental) |
| `GET /v1/tiktok/hashtag` | `truescrape tiktok hashtag --hashtag` | 1 | Hashtag details (experimental) |
| `GET /v1/tiktok/hashtag-videos` | `truescrape tiktok hashtag-videos --hashtag` | 1 | Videos using a hashtag (experimental) |
| `GET /v1/tiktok/live` | `truescrape tiktok live` | 1 | Live stream info (experimental) |
| `GET /v1/tiktok/playlist-videos` | `truescrape tiktok playlist-videos --playlist-id` | 1 | Videos in a playlist (experimental) |
| `GET /v1/tiktok/playlists` | `truescrape tiktok playlists --handle` | 1 | A creator's playlists (experimental) |
| `GET /v1/tiktok/product` | `truescrape tiktok product --url` | 1 | Product details (experimental) |
| `GET /v1/tiktok/profile` | `truescrape tiktok profile --handle` | 1 | Profile details (experimental) |
| `GET /v1/tiktok/profile/region` | `truescrape tiktok profile-region` | 1 | Creator region (experimental) |
| `GET /v1/tiktok/search/keyword` | `truescrape tiktok search-keyword --query` | 1 | Search videos by keyword (experimental) |
| `GET /v1/tiktok/search/suggestions` | `truescrape tiktok search-suggestions --query` | 1 | Search suggestions (experimental) |
| `GET /v1/tiktok/search/top` | `truescrape tiktok search-top --query` | 1 | Top (blended) search (experimental) |
| `GET /v1/tiktok/search/users` | `truescrape tiktok search-users --query` | 1 | Search creators (experimental) |
| `GET /v1/tiktok/shop/product/reviews` | `truescrape tiktok shop-product-reviews --url` | 1 | Product reviews (experimental) |
| `GET /v1/tiktok/shop/products` | `truescrape tiktok shop-products --url` | 1 | Seller's product catalogue (experimental) |
| `GET /v1/tiktok/shop/search` | `truescrape tiktok shop-search --query` | 1 | Search TikTok Shop (experimental) |
| `GET /v1/tiktok/song` | `truescrape tiktok song --song` | 1 | Sound / song details (experimental) |
| `GET /v1/tiktok/song-videos` | `truescrape tiktok song-videos --song` | 1 | Videos using a sound (experimental) |
| `GET /v1/tiktok/songs/popular` | `truescrape tiktok songs-popular` | 1 | Popular songs (experimental) |
| `GET /v1/tiktok/transcript` | `truescrape tiktok transcript --url` | 1 | Video transcript (experimental) |
| `GET /v1/tiktok/trending` | `truescrape tiktok trending` | 1 | Trending feed (experimental) |
| `GET /v1/tiktok/user/showcase` | `truescrape tiktok user-showcase --handle` | 1 | Creator's product showcase (experimental) |
| `GET /v1/tiktok/user-videos` | `truescrape tiktok user-videos --handle` | 1 | Videos posted by a creator (experimental) |
| `GET /v1/tiktok/video` | `truescrape tiktok video --url` | 1 | Video or photo-post details (experimental) |
| `GET /v1/tiktok/videos/popular` | `truescrape tiktok videos-popular` | 1 | Popular videos (experimental) |

### truthsocial (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/truthsocial/post` | `truescrape truthsocial post --url` | 1 | Post |
| `GET /v1/truthsocial/profile` | `truescrape truthsocial profile --handle` | 1 | Profile |
| `GET /v1/truthsocial/user/posts` | `truescrape truthsocial user-posts --handle` | 1 | User posts |

### twitch (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/twitch/clip` | `truescrape twitch clip --url` | 1 | Clip details |
| `GET /v1/twitch/profile` | `truescrape twitch profile --handle` | 1 | Channel profile |
| `GET /v1/twitch/user/schedule` | `truescrape twitch user-schedule --handle` | 1 | Stream schedule |
| `GET /v1/twitch/user/videos` | `truescrape twitch user-videos --handle` | 1 | Channel videos |

### twitter (6)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/twitter/community` | `truescrape twitter community --url` | 1 | Community details |
| `GET /v1/twitter/community/tweets` | `truescrape twitter community-tweets --url` | 1 | Community posts |
| `GET /v1/twitter/profile` | `truescrape twitter profile --handle` | 1 | Profile details |
| `GET /v1/twitter/tweet` | `truescrape twitter tweet --url` | 1 | Post details |
| `GET /v1/twitter/tweet/transcript` | `truescrape twitter tweet-transcript --url` | 1 | Post transcript (experimental) |
| `GET /v1/twitter/user-tweets` | `truescrape twitter user-tweets --handle` | 1 | Recent posts from an account |

### walmart (4)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/walmart/category` | `truescrape walmart category --category` | 3 | Browse a Walmart category |
| `GET /v1/walmart/product` | `truescrape walmart product --product-id` | 3 | Walmart product details |
| `GET /v1/walmart/reviews` | `truescrape walmart reviews --product-id` | 3 | Walmart product reviews |
| `GET /v1/walmart/search` | `truescrape walmart search --query` | 3 | Search Walmart |

### youtube (17)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/youtube/channel` | `truescrape youtube channel --handle` | 1 | Channel details |
| `GET /v1/youtube/channel/community-posts` | `truescrape youtube channel-community-posts --handle` | 1 | Channel community posts |
| `GET /v1/youtube/channel/lives` | `truescrape youtube channel-lives --handle` | 1 | Channel live streams |
| `GET /v1/youtube/channel/playlists` | `truescrape youtube channel-playlists --handle` | 1 | Channel playlists |
| `GET /v1/youtube/channel/shorts` | `truescrape youtube channel-shorts --handle` | 1 | Channel shorts |
| `GET /v1/youtube/channel-videos` | `truescrape youtube channel-videos --handle` | 1 | Channel videos |
| `GET /v1/youtube/community-post` | `truescrape youtube community-post --url` | 1 | Community post details |
| `GET /v1/youtube/playlist` | `truescrape youtube playlist --playlist-id` | 1 | Playlist contents |
| `GET /v1/youtube/search` | `truescrape youtube search --query` | 1 | Search videos |
| `GET /v1/youtube/search/hashtag` | `truescrape youtube search-hashtag --hashtag` | 1 | Search by hashtag |
| `GET /v1/youtube/search/typeahead` | `truescrape youtube search-typeahead --query` | 1 | Search typeahead |
| `GET /v1/youtube/shorts/trending` | `truescrape youtube shorts-trending` | 1 | Trending shorts |
| `GET /v1/youtube/transcript` | `truescrape youtube transcript --url` | 1 | Video transcript |
| `GET /v1/youtube/video` | `truescrape youtube video --url` | 1 | Video or Short details |
| `GET /v1/youtube/video/comment-replies` | `truescrape youtube video-comment-replies` | 1 | Comment replies |
| `GET /v1/youtube/video/comments` | `truescrape youtube video-comments --url` | 1 | Video comments |
| `GET /v1/youtube/video/sponsors` | `truescrape youtube video-sponsors --url` | 1 | Video sponsors (inferred) (experimental) |

### zillow (3)

| Endpoint | CLI | Credits | What it returns |
|---|---|---|---|
| `GET /v1/zillow/agent` | `truescrape zillow agent --url` | 1 | Zillow agent profile (experimental) |
| `GET /v1/zillow/property` | `truescrape zillow property` | 1 | Zillow listing details |
| `GET /v1/zillow/search` | `truescrape zillow search` | 1 | Search Zillow listings by location |
<!-- catalogue:end -->
