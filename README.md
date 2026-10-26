# @pipeworx/indonesia-law

Indonesian national law — statutes (Undang-Undang), Perpu, government and
presidential regulations, and Constitutional Court (Mahkamah Konstitusi)
judicial-review outcomes — from two official government legal-documentation
portals (JDIH): the State Secretariat (jdih.setneg.go.id) and the House of
Representatives (jdih.dpr.go.id). Keyless; every tool is a live call.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1881+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `idn_search_regulations(query?, type?, year?, status?, limit?, offset?)` —
  search the national register by Indonesian title words, instrument type
  (UU, PERPU, PP, PERPRES, KEPPRES, INPRES, PERMENSESNEG, KEPMENSESNEG) and
  year. Returns citation, title, legal status (`berlaku` in force / `sebagian`
  partially amended or revoked / `tidak berlaku`), enactment and promulgation
  dates, and the signed-copy PDF link.
- `idn_regulation_detail(type, number, year)` — one instrument's register
  record: state-gazette (LN/TLN) numbers, dates, legal status, PDF files, and
  its relations (amended by / amends / revoked by / revokes / related
  implementing regulations / judicial review).
- `idn_list_statutes(type?, year, query?, limit?)` — DPR's per-year list of
  statutes and executive instruments (uu, perpu, pp, perpres, keppres, inpres,
  perdpr, peraturanbersama) with the DPR id and a direct PDF.
- `idn_statute_detail(type?, dpr_id)` — DPR's record: Indonesian abstract with
  drafting notes, responsible commission, the Status list (what it amends or
  revokes, what amends it, and which ARTICLES the Constitutional Court struck
  down, with case numbers), the implementing-regulation table per article, and
  the PDF.
- `idn_mk_review_search(query?, category?, year?, limit?)` — Constitutional
  Court statute-review outcomes as documented by DPR: petitions granted
  (`granted`), rejected or inadmissible (`rejected`), DPR's post-ruling analyses
  (`analysis`) and DPR's statements in the case (`dpr_statement`). Search by
  case number (`91/PUU-XVIII/2020`), Indonesian statute words, or year.
- `idn_mk_review_detail(url)` — metadata and the resume PDF for one of those
  documents.

## Auth

Keyless.

## Data sources

- `https://jdih.setneg.go.id/api/hukumproduk/produkhukum` (POST JSON) — search
  the register. Body: `{tentang, p_lihan:"semua", jns:[…], thn:[…], status,
  terx:"All", sortOrder:"desc", length, start}`. `tentang` matches words in
  the Indonesian TITLE only — "tax" finds nothing, "pajak" does.
- `https://jdih.setneg.go.id/api/hukumproduk/detaildata` (POST
  `{jns,no,thn,k:""}`) — the record plus its file list;
  `/api/hukumproduk/status` (POST the record's relation id lists) — answers
  with HTML `<label>` chips whose `data-jns/data-no/data-thn/
  data-original-title` attributes are the related instruments. The PDF is
  served at `/api/hukumproduk/pdf?l=uploads&f=<realName>&fl=<idperaturan>`.
- `https://jdih.dpr.go.id/setjen/index/id/<Type>-BAGIAN-PERTIMBANGAN-DAN-DOKUMENTASI-INFORMASI-HUKUM/year/<yyyy>`
  — per-year statute lists (server-rendered HTML; without `/year/` only the
  newest handful is shown). Detail pages:
  `/setjen/detail-dokumen/tipe/<uu|pp|perpres|…>/id/<n>`; PDFs on
  `berkas.dpr.go.id/jdih/document/<type>/<n>.pdf`.
- `https://jdih.dpr.go.id/setjen/index/id/Info-Judicial-Review-Putusan-MK---Menyatakan-Mengabulkan-…`,
  `Resume-Putusan-MK---Menyatakan-Menolak,-Tidak-Dapat-Diterima-…`,
  `Analisis-dan-Evaluasi-UU-Berdasarkan-Putusan-MK-…`,
  `Keterangan-DPR-mengenai-Pengujian-UU-Terhadap-UUD-1945-…` — the four MK
  judicial-review collections (~820 documents on 2026-09-30), each list
  complete in one page; resume PDFs on `berkas.dpr.go.id/puspanlakuu/resume/`.

### Things the next person would otherwise rediscover

- **DPR answers HTTP 403 to a browser-shaped User-Agent sent by a non-browser
  client, and 200 to an honest bot UA.** Send ours; never spoof a browser.
- DPR's keyword search form (`POST /cari`) renders no results server-side, so
  the pack does not use it — list by type+year and filter titles instead, or
  search the Setneg register.
- Setneg's `/api/putusan/*` endpoints (court decisions) hold only Bawaslu
  material; its `MK` and `MA` categories return zero rows. The judicial-review
  coverage here comes from DPR's resumes, which name the case and the statute
  but are summaries, not the Court's full text.
- Setneg's `detaildata` record carries no `status_hukum`; the pack takes it
  from the search endpoint for the same type+year.
- `status="diluar"` on a relation chip means the related instrument is outside
  the Setneg register (`in_register:false`); it still has a full citation.

### Official sources checked and NOT usable (2026-09-30)

- `peraturan.go.id` and `jdihn.go.id` (Kemenkumham / BPHN national portals,
  103.145.96.x): connection timed out from a US residential IP and
  `ECONNREFUSED` from a second US egress — not reachable from outside
  Indonesia at the time of building.
- `www.mkri.id` (Constitutional Court), `jdih.mkri.id`,
  `putusan3.mahkamahagung.go.id` and `jdih.mahkamahagung.go.id` (Supreme Court
  decision directory), `peraturan.bpk.go.id` (BPK): HTTP 403 "Just a moment"
  Cloudflare JavaScript challenge for every non-browser client, bot UA or
  browser UA alike. Not solved on purpose.
- `api-jdih.perpusnas.go.id`: documented JSON API but `GET /token` answers
  401 `Application Key tidak ditemukan` — an application key issued by the
  National Library is required, so it is behind an authentication wall.
- `data.go.id`: reachable, but the Constitutional Court datasets there are
  case-count statistics, not decisions.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "indonesia-law": {
      "url": "https://gateway.pipeworx.io/indonesia-law/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/indonesia-law/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1881+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/idn_search_regulations \
  -H 'Content-Type: application/json' \
  -d '{"query":"cipta kerja","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/idn_search_regulations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "indonesia-law": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-indonesia-law"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-indonesia-law
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Indonesia Law data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
