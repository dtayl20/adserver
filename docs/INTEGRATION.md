# Pasting ad tags into real sites

Get the tag from the console: **Zones → Tag**. It always looks like this:

```html
<div id="adsrv-zone-1"></div>
<script async src="https://ads.example.com/z/1.js" data-zone="1" data-target="#adsrv-zone-1"></script>
```

The loader only touches the element you point `data-target` at (or the position
right after the script if you omit it). It does not read the page, does not set
cookies, and does not require jQuery or anything else.

## Attributes

| Attribute | Default | Meaning |
|---|---|---|
| `data-zone` | from the tag | zone id (only needed on `/ads.js` tags) |
| `data-target` | after the script | CSS selector of the slot element |
| `data-mode` | zone setting | `iframe` (safe default) or `inline` (image/text only) |
| `data-width` / `data-height` | zone size | override the served size |
| `data-resize` | `0` | `1` lets the creative grow the frame via `postMessage` |
| `data-lazy` | `1` when `data-target` is set | `0` loads immediately |
| `data-fallback` | — | selector of an element to reveal when no ad is served |
| `data-max-per-visitor` | `0` | cap renders for this visitor per day (stored on the host origin) |
| `data-class` | — | extra class on the generated slot element |

## Plain HTML / static sites

```html
<!-- sidebar -->
<div id="adsrv-zone-2"></div>
<script async src="https://ads.example.com/z/2.js" data-target="#adsrv-zone-2" data-fallback="#advertise-here"></script>
<div id="advertise-here" style="display:none">Advertise here — <a href="/advertise">get in touch</a></div>
```

## WordPress

Classic editor or Gutenberg **Custom HTML** block: paste the tag as-is. In PHP
templates, echo the same markup inside the loop you want it in. A shortcode
wrapper keeps templates tidy:

```php
add_shortcode('adserver', function ($atts) {
  $a = shortcode_atts(['zone' => '1', 'w' => '', 'h' => ''], $atts);
  $id = 'adsrv-zone-' . esc_attr($a['zone']);
  $size = ($a['w'] && $a['h']) ? sprintf(' data-width="%s" data-height="%s"', esc_attr($a['w']), esc_attr($a['h'])) : '';
  return sprintf(
    '<div id="%1$s"></div><script async src="https://ads.example.com/z/%2$s.js"%3$s data-target="#%1$s"></script>',
    $id, esc_attr($a['zone']), $size
  );
});
```

Usage: `[adserver zone="2" w="300" h="250"]`

## Wix / Squarespace / Shopify

- **Wix**: Add → Embed → Custom Embed → "HTML code" (use an Embed, not an HTML iframe widget).
- **Squarespace**: add a Code Block.
- **Shopify**: Theme → Edit code, or a Custom Liquid section; in the theme editor use a Custom HTML block.

## HTML5 creatives

Upload the creative in the console (Banner → type `html`, paste the markup), or
serve it from elsewhere and reference it. Two rules:

1. Use `{{CLICK_URL}}` for the click-through — plain links will not be counted,
   and the creative runs sandboxed so `target="_top"` navigations are blocked.
   `target="_blank"` works.
2. Keep the creative within the banner's declared size; it is rendered in a frame
   of that size. If it must grow, ask for `data-resize="1"` on the tag and make
   the creative document finish loading at its natural height.

Available macros: `{{CLICK_URL}}`, `{{CACHEBUSTER}}`, `{{AD_WIDTH}}`,
`{{AD_HEIGHT}}`, `{{ZONE_ID}}`, `{{BANNER_ID}}`, `{{CAMPAIGN_ID}}`, `{{PAGE_URL}}`.

```html
<a href="{{CLICK_URL}}" target="_blank" rel="noopener">
  <img src="https://cdn.example.com/creative-728x90.png" width="728" height="90" alt="Campaign">
</a>
```

## Choosing a mode

| | iframe (default) | inline |
|---|---|---|
| Creative types | image, html, text | image, text |
| Host page isolation | full | full for image/text (no HTML is parsed) |
| Reflows with page CSS | no | yes (width 100%, height follows content) |
| Use when | anything goes wrong; any HTML5 creative | you need the ad to sit in the page flow |

## Targeting

Zone **Allow on pages** / **Block on pages** accept one pattern per line:

```
example.com                 the domain and any subdomain
*.example.com               subdomains only (wildcard)
/blog*                      path prefix, including query string
example.com/private*        host and path must both match
https://example.com/news*   full URL prefix
```

Block always beats allow. An empty allow list means "any page".

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slot stays empty | no eligible campaign for this zone, caps reached, or the page is blocked by a targeting pattern |
| Ad appears but the console shows 0 impressions | the visitor is in the bot filter list, or the request came from a private/incognito context hitting a stale cached tag |
| Wrong size | `data-width`/`data-height` on the tag, or the zone size, or the banner size — the frame follows the tag/zone, the creative is centred inside it |
| Click does not register | `{{CLICK_URL}}` was not used, or `CLICK_SECRET` is unset in the Worker |
| Ad shows in a preview but not on the site | the tag's `data-zone` does not match a live zone, or Access is blocking a path under `/z/...` (it must stay public) |
| Nothing loads at all | check `curl -i https://ads.example.com/z/1.js` returns JavaScript, and that the zone is active |
