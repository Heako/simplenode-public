# BytePlus ModelArk — verification notes (step 0)

Checked on Nov 2, 2026 on docs.byteplus.com. Only what the docs say is recorded; anything they don't say is flagged as such.

Sources:
- [S1] Create a video generation task — https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api (updated Oct 27, 2026)
- [S2] Retrieve a video generation task — https://docs.byteplus.com/en/docs/modelark/get-video-generation-task-api
- [S3] Dreamina Seedance 2.5 tutorial — https://docs.byteplus.com/en/docs/ModelArk/2607688
- [S4] Create portrait videos with Dreamina Seedance models — https://docs.byteplus.com/en/docs/modelark/seedance-portrait-asset-guide (updated Oct 8, 2026)
- [S5] Private virtual portrait library — https://docs.byteplus.com/en/docs/ModelArk/2333565 (updated Oct 13, 2026)
- [S6] CreateAsset — https://docs.byteplus.com/en/docs/modelark/create-asset-api
- [S7] Pricing — https://docs.byteplus.com/en/docs/modelark/model-pricing
- [S8] Seedream 5.0 pro / flash tutorial — https://docs.byteplus.com/en/docs/modelark/seedream-5-0-pro
- [S9] List video generation tasks — https://docs.byteplus.com/en/docs/modelark/list-video-generation-tasks-api
- [S10] Cancel or delete a video generation task — https://docs.byteplus.com/en/docs/modelark/cancel-or-delete-video-generation-tasks-api
- [S11] ListAssetGroups — https://docs.byteplus.com/en/docs/modelark/list-asset-groups-api

## 0.1 Authentication, host, region

There are **two** authentication modes, depending on the API:

| API | Auth | Host |
|---|---|---|
| Video / image generation (`/api/v3/...`) | **API key** only, `Authorization: Bearer <ARK_API_KEY>` [S1] | `https://ark.ap-southeast.bytepluses.com/api/v3` |
| Assets (portrait library) | **AK/SK** only (`HMAC-SHA256` signature, service `ark`, region `ap-southeast-1`, signed headers `content-type;host;x-content-sha256;x-date`) [S5][S6] | `https://ark.ap-southeast-1.byteplusapi.com/?Action=<Action>&Version=2024-01-01` |

Documented region: `ap-southeast-1` (Johor). No other region appears in the pages read.

Consequence: way A (portraits) needs an Access Key / Secret Key pair (BytePlus console › IAM) **in addition to** the API key.

Model activation [S1][S3]: balance > USD 30, or an AI Savings Plan ≥ USD 30, or a Seedance resource pack.

## 0.2 Video task API

- Create: `POST /api/v3/contents/generations/tasks` → `{ "id": "cgt-…" }` [S1]
- Status: `GET /api/v3/contents/generations/tasks/{id}` [S2]. Statuses: `queued`, `running`, `cancelled`, `succeeded`, `failed`, `expired`. On failure: `error.code`, `error.message`. Result: `content.video_url` (+ `content.last_frame_url` with `return_last_frame`), `usage.completion_tokens`, `created_at`, `draft`.
- Cancel: `DELETE /api/v3/contents/generations/tasks/{id}` [S10]. A `queued` task becomes `cancelled`; a `running` task **can't** be cancelled (it runs to the end and is billed). On a finished task, the same call deletes the record.
- Seedance 2.5 model id: **`dreamina-seedance-2-5-260628`** [S1][S7]
- Retention: `video_url` valid **24 h**, and for Seedance 2.5 downloadable **100 times at most** [S2]. Task id valid 7 days (14 days for a Draft) [S1].

## 0.3 Task fields [S1][S3]

- `content[]`: `{type:"text", text}`; `{type:"image_url", image_url:{url}, role}`; `{type:"video_url", …, role:"reference_video"}`; `{type:"audio_url", …, role:"reference_audio"}`; `{type:"draft_task", draft_task:{id}}`.
- `image_url.url`: public URL, `data:image/<fmt>;base64,…` or `asset://<ID>`.
- Image roles: `first_frame`, `last_frame`, `reference_image` (1 to 30 for 2.5).
- **First/last frame and references (omni reference) are exclusive**: they can't be combined in one task. For 2.5, in first-frame mode, `ratio` must be `adaptive`.
- `resolution`: 480p, 720p, 1080p (2.5). `ratio`: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, adaptive. `duration`: [4, 30] or -1 (default -1 for 2.5). `frames` possible.
- `generate_audio` (default true), `seed` [-1, 2147483647], `watermark` (default false), `return_last_frame`, `output_format` (mp4/mov), `omni_reference_task_type` (auto/reference/edit/extend), `execution_expires_after`, `priority`, `safety_identifier`.
- **No negative prompt** in the docs.
- Image: jpeg/png/webp/bmp/tiff/gif/heic, ratio [0.4, 2.5], sides [300, 6000] px, < 30 MB, request body ≤ 64 MB.
- In the prompt, refer to assets as "Image 1", "Image 2"… (order in the request), never by their id [S5].

## 0.4 Draft mode [S1][S3]

- `draft: true` on creation; resolution must be `480p`. Billed like a regular 480p video.
- Finalizing: a new task, same `model`, `content: [{type:"draft_task", draft_task:{id}}]`, `resolution: "1080p"` (the only value accepted for 2.5), without `draft`.
- **Not to be sent again** (reused automatically): prompt, reference images/videos/audio, duration, ratio, seed, generate_audio, omni_reference_task_type. Can be sent again: return_last_frame, output_format, watermark, service_tier, execution_expires_after, priority, callback_url, safety_identifier.
- Draft id validity: **14 days** from `created_at` (ids created since Oct 28, 2026 10:00 UTC+8; 7 days before).

## 0.5 Virtual portrait library [S5][S6]

- Prerequisites: activate the **Advanced Creation Rights**; sign an authorization letter in the console on the **first group creation**. Capacity quota shared with the "real people" library.
- Create a group: `CreateAssetGroup` { `Name`, `Description`, `GroupType` (only `AIGC`), `ProjectName` (default `default`) } → `Id: group-…`. 10 QPS.
- Upload: `CreateAsset` { `GroupId`, `URL`, `AssetType` (`Image`/`Video`/`Audio`), `Name`, `ProjectName`, `Moderation` } → `Result.Id: asset-…`. Asynchronous, no SLA.
  - **Only a reachable URL is accepted; base64 isn't supported** [S6]. A local image must therefore be hosted somewhere first.
  - `Moderation: {Strategy:"Skip"}` turns off the pre-filter: **not used** (out of scope, § 6 of the spec).
- Status: `GetAsset` { `Id`, `ProjectName` } → `Status`: `Processing`, `Active` (usable), `Failed`. 100 QPS. **The reason for a refusal isn't documented** in the pages read (no "reason" field in the examples).
- Delete: `DeleteAsset`, `DeleteAssetGroup`. List: `ListAssets`, `ListAssetGroups`.
- `ListAssetGroups` requires `Filter` with `Filter.GroupType` (`AIGC`: virtual portraits; `LivenessFace`: real people); `Filter.Name` (fuzzy search, 64 chars) and `Filter.GroupIds` are optional; `MaxResults` 1 to 100 (default 10). [S11] Checked live on Nov 2, 2026: without `Filter`, the answer is `MissingParameter.Filter`.
- SimpleNode's AK/SK signature is accepted by BytePlus (checked live on Nov 2, 2026). The IAM user needs a policy allowing `ark:*Asset*` on the `default` project, otherwise: "User is not authorized to perform: ark:ListAssetGroups".
- Image formats: jpeg, png, webp, tiff, gif, heic/heif; ratio (0.4, 2.5); sides (300, 6000) px; < 30 MB.
- Assets are isolated per `ProjectName`: generate with an endpoint of the same project.
- Conditions: a character that resembles no real person, no brand or logo, rights held by the user. BytePlus runs a safety review.

## 0.6 `asset://` as a first frame?

**Not documented.** The docs say `image_url.url` accepts an `asset://` without restricting the role, but every example uses `reference_image` [S4][S5]. Treated as a reference only until confirmed.

## 0.7 Seedream and trusted outputs [S4][S8]

- Endpoint: `POST /api/v3/images/generations` (Bearer). Models: `dola-seedream-5-0-pro-260628`, `dola-seedream-5-0-flash-260915` (lite: `seedream-5-0-lite-260128` [S7]). Parameters: `prompt`, `image` (URL or base64, up to 10 references), `size` (1K/1.5K/2K), `output_format` (png/jpeg), `response_format` (`url`), `watermark`. Output URL kept **24 h**.
- Trust: Seedance 2.0/2.5 accept as inputs Seedream 5.0 lite/pro/flash **text-to-image** images with a face, and Seedance 2.x videos (and last frames) with a face, **generated on the same ModelArk account within the last 30 days**, **original** (not edited).
- "Compressing or forwarding the file may invalidate the check; BytePlus recommends saving the originals to BytePlus TOS." **The check mechanism (fingerprint, metadata, URL) isn't documented.** A trusted output has no asset id: the image itself is sent (the original URL while it lives, or the untouched original file).
- Only **text-to-image** is listed: a Seedream image made with reference images isn't mentioned as trusted.

## 0.8 Prices and limits [S7]

- Billed per token; tokens = width × height × 24 × duration / 1024 (checked: 854×480×24×5/1024 ≈ 48,037 tokens → $0.514 for 5 s at 480p).
- `dreamina-seedance-2-5-260628`, without video input: **$10.70 / M tokens** (480p/720p), **$11.70 / M** (1080p). With video input: $6.40 / M and $7.00 / M (the input video's tokens count too).
- Official examples 16:9, 5 s, without video input: 480p **$0.514** ($0.103/s), 720p $1.156, 1080p **$2.843** ($0.569/s).
- Draft: billed as 480p; finalizing billed at the target resolution (1080p).
- Seedream [S7]: `dola-seedream-5-0-pro-260628` $0.045 per image up to 2.61 MP (≤ 1.5K), $0.09 above (2K); input images: the first is free, $0.003 each after that. `dola-seedream-5-0-flash-260915` $0.018, free inputs. `seedream-5-0-lite-260128` $0.035.
- Portraits (CreateAsset): no per-call price; they need Advanced Creation Rights. Tiers ([purchase guide](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/seedance-2-0-purchase-guide), read 2026-11-03): Basic (free) — no virtual portrait upload, console or API; Entry (free) — virtual portraits by console and API, 50 assets / 50 groups, 3 QPM, needs an enterprise-verified account; Advanced ($1,400/month) — 1M assets, 120 QPM; Premium ($4,200/month) — 5M assets, 300 QPM. Assets created in Entry are not deleted when a paid tier lapses.
- Seedance 2.5 RPM / concurrency: deferred to the "Model list", **not recorded**.

## Live checks

Log of tests on a real BytePlus account. No generation is launched without the account owner's approval.

| Date | Test | Result |
|---|---|---|
| Nov 2, 2026 | API key: `GET /contents/generations/tasks?page_size=1` | Passed |
| Nov 2, 2026 | AK/SK, `ListAssetGroups` without IAM permission | `User is not authorized to perform: ark:ListAssetGroups on resource: trn:iam::<account>:project/default`: the signature is accepted, only the permission is missing |
| Nov 2, 2026 | AK/SK, `ListAssetGroups` without `Filter` | `MissingParameter.Filter` (fixed: `Filter.GroupType = "AIGC"`) |
| Nov 2, 2026 | AK/SK, `ListAssetGroups` with `Filter.GroupType` and the `ark:*Asset*` policy attached | Passed |

Acceptance criterion 2 of the spec ("Test connection"): met. Still to do, with the user's approval: AI Portrait of Nora (criterion 3), 5 s Draft with that portrait (4), 1080p finalization (5), and MCP budget refund on a refusal (6).

Pitfalls met:
- ModelArk's "API keys" page shows an **API Key** and a **Resource ID**. Only the API Key is used; the Resource ID is the key's id in the console.
- Creating an API key also creates an IAM user (`simplenode-xxxxx`). That's the user the `ark:*Asset*` policy is attached to, and the one an Access Key is created for: its rights stay limited to portraits.
