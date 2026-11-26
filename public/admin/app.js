/* adserver — management console (vanilla, no build step).
   Talks to /api/admin/* with the x-adserver-admin header; Cloudflare Access
   supplies and verifies the identity in front of it. */
(function () {
  'use strict';

  var state = {
    me: null,
    sites: [],
    zones: [],
    campaigns: [],
    banners: [],
    overview: null,
    report: null,
    reportQuery: { group: 'banner', from: '', to: '' },
  };

  var VIEWS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'sites', label: 'Sites' },
    { id: 'zones', label: 'Zones' },
    { id: 'campaigns', label: 'Campaigns' },
    { id: 'banners', label: 'Banners' },
    { id: 'report', label: 'Report' },
  ];

  var main = document.getElementById('main');
  var tabs = document.getElementById('tabs');
  var who = document.getElementById('who');
  var envTag = document.getElementById('env-tag');
  var backdrop = document.getElementById('modal-backdrop');
  var modalForm = document.getElementById('modal-form');
  var modalTitle = document.getElementById('modal-title');
  var toastEl = document.getElementById('toast');

  // ------------------------------------------------------------------ utils
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmt(number) {
    return Number(number || 0).toLocaleString('en-AU');
  }

  function ctr(impressions, clicks) {
    if (!impressions) return '—';
    return ((clicks / impressions) * 100).toFixed(2) + '%';
  }

  // Local dev only: the shell injects this meta tag when ENVIRONMENT=dev, and
  // the API expects it as a header. Absent in production, where Cloudflare
  // Access supplies the verified identity instead.
  var DEV_TOKEN = (function () {
    var meta = document.querySelector('meta[name="adsrv-dev-token"]');
    return meta ? meta.getAttribute('content') : '';
  })();

  function adminHeaders(extra) {
    var headers = { 'x-adserver-admin': '1' };
    if (DEV_TOKEN) headers['x-dev-admin-token'] = DEV_TOKEN;
    if (extra) {
      Object.keys(extra).forEach(function (key) {
        headers[key] = extra[key];
      });
    }
    return headers;
  }

  // Browser navigations (iframe documents, new tabs) cannot carry the dev
  // header, so locally the token travels in the query string instead.
  function devTokenQuery() {
    return DEV_TOKEN ? 'dev_token=' + encodeURIComponent(DEV_TOKEN) : '';
  }

  var toastTimer = null;
  function toast(message, isError) {
    toastEl.textContent = message;
    toastEl.className = 'toast' + (isError ? ' error' : '');
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.hidden = true;
    }, isError ? 6000 : 3000);
  }

  // The async clipboard API rejects when the document is not focused and is
  // unavailable over plain HTTP, so never rely on it alone: fall back to a
  // hidden textarea + execCommand, and select the text so a manual Ctrl+C works.
  function selectText(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (error) {
      /* selection is best effort */
    }
  }

  function copyText(value) {
    return new Promise(function (resolve) {
      function legacyCopy() {
        try {
          var area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.top = '-1000px';
          document.body.appendChild(area);
          area.select();
          var ok = false;
          try {
            ok = document.execCommand('copy');
          } catch (error) {
            ok = false;
          }
          document.body.removeChild(area);
          resolve(ok);
        } catch (error) {
          resolve(false);
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(
          function () { resolve(true); },
          legacyCopy
        );
        return;
      }
      legacyCopy();
    });
  }

  function api(path, options) {
    var opts = options || {};
    var headers = adminHeaders(opts.json !== undefined ? { 'content-type': 'application/json' } : null);
    return fetch(path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return { ok: false, error: response.status + ' ' + response.statusText };
        })
        .then(function (data) {
          if (!response.ok || data.ok === false) {
            throw new Error(data.error || response.status + ' ' + response.statusText);
          }
          return data;
        });
    });
  }

  // ------------------------------------------------------------------ modal
  var modalSubmit = null;
  // Field definitions for the open modal, so submission knows which controls are
  // genuinely multi-value (a single checked box in a group must still be an array).
  var modalFields = null;

  function fieldHtml(field, value) {
    var id = 'f-' + field.name;
    var v = value === undefined || value === null ? '' : value;
    var control;
    if (field.type === 'textarea') {
      control = '<textarea id="' + id + '" name="' + field.name + '">' + esc(v) + '</textarea>';
    } else if (field.type === 'select') {
      control =
        '<select id="' + id + '" name="' + field.name + '">' +
        (field.options || [])
          .map(function (option) {
            return (
              '<option value="' + esc(option.value) + '"' + (String(option.value) === String(v) ? ' selected' : '') + '>' +
              esc(option.label) +
              '</option>'
            );
          })
          .join('') +
        '</select>';
    } else if (field.type === 'checkbox') {
      return (
        '<div class="field' + (field.full ? ' full' : '') + '"><label class="check">' +
        '<input type="checkbox" id="' + id + '" name="' + field.name + '"' + (v ? ' checked' : '') + '> ' +
        esc(field.label) +
        '</label>' + (field.hint ? '<div class="hint">' + esc(field.hint) + '</div>' : '') + '</div>'
      );
    } else if (field.type === 'zones') {
      control =
        '<div id="' + id + '">' +
        (state.zones.length
          ? state.zones
              .map(function (zone) {
                var checked = (v || []).indexOf(zone.id) !== -1 ? ' checked' : '';
                return (
                  '<label class="check" style="margin-top:.3rem"><input type="checkbox" name="' + field.name + '" value="' +
                  zone.id + '"' + checked + '> ' +
                  esc(zone.name) + ' <span class="muted small">#' + zone.id + ' · ' + zone.width + '×' + zone.height + '</span></label>'
                );
              })
              .join('')
          : '<p class="muted small">No zones yet.</p>') +
        '</div>';
    } else if (field.type === 'file') {
      control = '<input type="file" id="' + id + '" name="' + field.name + '" accept="image/png,image/jpeg,image/gif,image/webp">';
    } else {
      control =
        '<input type="' + field.type + '" id="' + id + '" name="' + field.name + '" value="' + esc(v) + '"' +
        (field.step ? ' step="' + field.step + '"' : '') + '>';
    }
    return (
      '<div class="field' + (field.full ? ' full' : '') + '">' +
      '<label for="' + id + '">' + esc(field.label) + '</label>' + control +
      (field.hint ? '<div class="hint">' + esc(field.hint) + '</div>' : '') +
      '</div>'
    );
  }

  function openModal(title, fields, values, onSubmit) {
    modalTitle.textContent = title;
    modalForm.innerHTML = '<div class="grid">' + fields.map(function (field) {
      return fieldHtml(field, values ? values[field.name] : field.value);
    }).join('') + '</div>';
    modalSubmit = onSubmit;
    modalFields = fields;
    backdrop.hidden = false;
    var first = modalForm.querySelector('input,select,textarea');
    if (first) first.focus();
  }

  function closeModal() {
    backdrop.hidden = true;
    modalSubmit = null;
  }

  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  backdrop.addEventListener('click', function (event) {
    if (event.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !backdrop.hidden) closeModal();
  });

  modalForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (!modalSubmit) return closeModal();

    // Group controls by name: repeated checkboxes become arrays, everything
    // else takes its single value.
    var groups = {};
    Array.prototype.forEach.call(modalForm.querySelectorAll('[name]'), function (node) {
      if (!groups[node.name]) groups[node.name] = [];
      groups[node.name].push(node);
    });

    var values = {};
    var formData = new FormData(modalForm);
    var multi = {};
    (modalFields || []).forEach(function (field) {
      if (field.type === 'zones') multi[field.name] = true;
    });

    Object.keys(groups).forEach(function (name) {
      var group = groups[name];
      var first = group[0];
      if (first.type === 'checkbox') {
        if (multi[name]) {
          // Read straight from the form: only ticked boxes are present, and the
          // value is an array even when a single zone is ticked.
          values[name] = formData.getAll(name).map(function (value) {
            return Number(value);
          });
          return;
        }
        values[name] = first.checked ? 1 : 0;
        return;
      }
      if (first.type === 'file') {
        values[name] = first.files && first.files[0] ? first.files[0] : null;
        return;
      }
      values[name] = first.value;
    });

    // A campaign with no zones serves nowhere, which is almost always a mistake
    // rather than an intent — confirm before saving that.
    var zonesEmpty = Object.keys(multi).some(function (name) {
      return Array.isArray(values[name]) && values[name].length === 0;
    });
    if (zonesEmpty && !window.confirm('No zones are ticked, so this campaign will not serve anywhere. Save anyway?')) {
      return;
    }

    Promise.resolve(modalSubmit(values))
      .then(function () {
        closeModal();
      })
      .catch(function (error) {
        toast(error.message, true);
      });
  });

  function zonesSavedMessage(data) {
    var zones = data && data.zoneIds ? data.zoneIds : null;
    if (!zones) return 'Saved';
    return zones.length
      ? 'Saved - linked to zone ' + zones.join(', ')
      : 'Saved - no zones linked, so it will not serve anywhere';
  }

  function saveCampaign(path, method, values) {
    return api(path, { method: method, json: values }).then(function (data) {
      return refresh(false).then(function () {
        toast(zonesSavedMessage(data));
      });
    });
  }

  // ------------------------------------------------------------------- views
  function renderTabs() {
    var view = currentView();
    tabs.innerHTML = VIEWS.map(function (item) {
      return (
        '<a href="#/' + item.id + '"' + (item.id === view ? ' class="active"' : '') + '>' + esc(item.label) + '</a>'
      );
    }).join('');
  }

  function currentView() {
    var hash = (location.hash || '').replace(/^#\/?/, '');
    for (var i = 0; i < VIEWS.length; i++) {
      if (VIEWS[i].id === hash) return hash;
    }
    return 'dashboard';
  }

  function errorPanel(message) {
    return (
      '<div class="panel"><h2>Could not load the console</h2>' +
      '<p class="error">' + esc(message) + '</p>' +
      '<p class="muted small">If this is a Cloudflare Access error, sign in again and reload. ' +
      'Locally, set ACCESS_DEV_TOKEN in .dev.vars and open the console through <code>wrangler dev</code>.</p></div>'
    );
  }

  function badge(text, kind) {
    return '<span class="badge' + (kind ? ' ' + kind : '') + '">' + esc(text) + '</span>';
  }

  function chart(rows) {
    if (!rows || !rows.length) return '<p class="muted small">No data in this range.</p>';
    var max = Math.max.apply(null, rows.map(function (row) { return row.impressions || 0; }).concat([1]));
    return (
      '<div class="chart">' +
      rows
        .map(function (row) {
          var height = Math.max(2, Math.round(((row.impressions || 0) / max) * 100));
          return (
            '<div class="bar" style="height:' + height + '%" title="' +
            esc(row.day + ': ' + fmt(row.impressions) + ' impressions, ' + fmt(row.clicks) + ' clicks') + '">' +
            '<span>' + esc(String(row.day).slice(5)) + '</span></div>'
          );
        })
        .join('') +
      '</div><div style="height:1.2rem"></div>'
    );
  }

  function groupTable(rows, firstColumn) {
    if (!rows || !rows.length) return '<p class="muted small">No data in this range.</p>';
    return (
      '<table><thead><tr><th>' + esc(firstColumn) + '</th><th class="num">Impressions</th><th class="num">Clicks</th><th class="num">CTR</th></tr></thead><tbody>' +
      rows
        .map(function (row) {
          return (
            '<tr><td>' + esc(row.label || ('#' + row.key)) + '</td>' +
            '<td class="num">' + fmt(row.impressions) + '</td>' +
            '<td class="num">' + fmt(row.clicks) + '</td>' +
            '<td class="num">' + ctr(row.impressions, row.clicks) + '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>'
    );
  }

  function viewDashboard() {
    var overview = state.overview;
    var today = overview.today;
    var period = overview.period;
    return (
      '<h1>Dashboard</h1><p class="muted small">Reporting timezone: ' + esc(overview.range.timezone) +
      ' · last ' + overview.range.days + ' days</p>' +
      '<div class="cards">' +
      '<div class="card"><div class="label">Impressions today</div><div class="value">' + fmt(today.impressions) + '</div></div>' +
      '<div class="card"><div class="label">Clicks today</div><div class="value">' + fmt(today.clicks) + '</div><div class="detail">CTR ' + ctr(today.impressions, today.clicks) + '</div></div>' +
      '<div class="card"><div class="label">Impressions · ' + overview.range.days + 'd</div><div class="value">' + fmt(period.impressions) + '</div></div>' +
      '<div class="card"><div class="label">Clicks · ' + overview.range.days + 'd</div><div class="value">' + fmt(period.clicks) + '</div><div class="detail">CTR ' + ctr(period.impressions, period.clicks) + '</div></div>' +
      '<div class="card"><div class="label">Zones</div><div class="value">' + fmt(overview.counts.zones) + '</div></div>' +
      '<div class="card"><div class="label">Sites</div><div class="value">' + fmt(overview.counts.sites) + '</div></div>' +
      '<div class="card"><div class="label">Campaigns</div><div class="value">' + fmt(overview.counts.campaigns) + '</div></div>' +
      '<div class="card"><div class="label">Banners</div><div class="value">' + fmt(overview.counts.banners) + '</div></div>' +
      '</div>' +
      '<div class="panel"><h2>Impressions by day</h2>' + chart(overview.byDay) + '</div>' +
      '<div class="panel"><h2>Top zones</h2>' + groupTable(overview.byZone, 'Zone') + '</div>' +
      '<div class="panel"><h2>Top banners</h2>' + groupTable(overview.byBanner, 'Banner') + '</div>'
    );
  }

  function viewSites() {
    var stats = {};
    ((state.overview && state.overview.bySite) || []).forEach(function (row) {
      stats[row.key] = row;
    });

    var rows = state.sites.length
      ? state.sites
          .map(function (site) {
            var stat = stats[site.id] || { impressions: 0, clicks: 0 };
            return (
              '<tr><td>#' + site.id + '</td><td>' + esc(site.name) +
              (site.domain ? '<div class="muted small">' + esc(site.domain) + '</div>' : '') + '</td>' +
              '<td class="num">' + fmt((site.zoneIds || []).length) + '</td>' +
              '<td class="num">' + fmt(stat.impressions) + '</td>' +
              '<td class="num">' + fmt(stat.clicks) + '</td>' +
              '<td class="num">' + ctr(stat.impressions, stat.clicks) + '</td>' +
              '<td>' + (site.active ? badge('active', 'ok') : badge('inactive', 'warn')) + '</td>' +
              '<td class="actions">' +
              '<button class="btn small" data-action="site-zones" data-id="' + site.id + '">Zones</button> ' +
              '<button class="btn small" data-action="edit-site" data-id="' + site.id + '">Edit</button> ' +
              '<button class="btn small danger" data-action="delete-site" data-id="' + site.id + '">Delete</button>' +
              '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="8" class="muted">No sites yet — create one, then attach zones to it.</td></tr>';

    var unassigned = state.zones.filter(function (zone) {
      return !zone.site_id;
    }).length;

    return (
      '<h1>Sites</h1><p class="muted small">A site groups the ad slots on one website. ' +
      'Impressions are reported across its zones; the embed code does not change.</p>' +
      (unassigned
        ? '<p class="muted small">' + fmt(unassigned) + ' zone' + (unassigned === 1 ? ' is' : 's are') +
          ' not assigned to a site yet — edit a zone to attach it.</p>'
        : '') +
      '<div class="panel"><div class="panel-head"><h2>All sites</h2>' +
      '<span class="spacer"></span><button class="btn primary" data-action="new-site">New site</button></div>' +
      '<table><thead><tr><th>ID</th><th>Site</th><th class="num">Zones</th>' +
      '<th class="num">Impressions</th><th class="num">Clicks</th><th class="num">CTR</th>' +
      '<th>Status</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<p class="muted small">Traffic columns cover the dashboard range (' +
      ((state.overview && state.overview.range.days) || 14) + ' days).</p></div>' +
      '<div id="site-extra"></div>'
    );
  }

  function viewZones() {
    var siteName = {};
    state.sites.forEach(function (site) {
      siteName[site.id] = site.name;
    });

    var rows = state.zones.length
      ? state.zones
          .map(function (zone) {
            return (
              '<tr><td>#' + zone.id + '</td><td>' + esc(zone.name) + '</td>' +
              '<td>' + (zone.site_id
                ? esc(siteName[zone.site_id] || ('#' + zone.site_id))
                : '<span class="muted">—</span>') + '</td>' +
              '<td>' + zone.width + '×' + zone.height + (zone.auto_height ? ' auto' : '') + '</td>' +
              '<td>' + esc(zone.mode) + '</td>' +
              '<td>' + (zone.active ? badge('active', 'ok') : badge('inactive', 'warn')) + '</td>' +
              '<td>' + fmt((zone.campaigns || []).length) + '</td>' +
              '<td class="actions">' +
              '<button class="btn small" data-action="snippet" data-id="' + zone.id + '">Code</button> ' +
              '<button class="btn small" data-action="preview-zone" data-id="' + zone.id + '">Preview</button> ' +
              '<button class="btn small" data-action="edit-zone" data-id="' + zone.id + '">Edit</button> ' +
              '<button class="btn small danger" data-action="delete-zone" data-id="' + zone.id + '">Delete</button>' +
              '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="8" class="muted">No zones yet — create one, then paste its code on a page.</td></tr>';

    return (
      '<h1>Zones</h1><p class="muted small">A zone is one ad slot. Its code is what you drop on a page.</p>' +
      '<div class="panel"><div class="panel-head"><h2>All zones</h2>' +
      '<span class="spacer"></span><button class="btn primary" data-action="new-zone">New zone</button></div>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th>Site</th><th>Size</th><th>Mode</th><th>Status</th><th class="num">Campaigns</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div id="zone-extra"></div>'
    );
  }

  function viewCampaigns() {
    var rows = state.campaigns.length
      ? state.campaigns
          .map(function (campaign) {
            var statusKind = campaign.status === 'active' ? 'ok' : campaign.status === 'paused' ? 'warn' : '';
            var window = (campaign.starts_at || '—') + ' → ' + (campaign.ends_at || '—');
            return (
              '<tr><td>#' + campaign.id + '</td><td>' + esc(campaign.name) + '<div class="muted small">' + esc(campaign.advertiser || '') + '</div></td>' +
              '<td class="num">' + campaign.priority + '</td><td class="num">' + campaign.weight + '</td>' +
              '<td class="small">' + esc(window) + '</td>' +
              '<td class="small">' + (campaign.imp_cap ? fmt(campaign.imp_cap) + ' imp' : '—') + '<br>' + (campaign.click_cap ? fmt(campaign.click_cap) + ' clk' : '') + '</td>' +
              '<td class="small">' + esc((campaign.zoneIds || []).join(', ') || '—') + '</td>' +
              '<td>' + badge(campaign.status, statusKind) + '</td>' +
              '<td class="actions">' +
              '<button class="btn small" data-action="edit-campaign" data-id="' + campaign.id + '">Edit</button> ' +
              '<button class="btn small danger" data-action="delete-campaign" data-id="' + campaign.id + '">Delete</button>' +
              '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="9" class="muted">No campaigns yet.</td></tr>';

    return (
      '<h1>Campaigns</h1><p class="muted small">Priority decides precedence (0 beats 10). Weight sets share of voice inside the same priority.</p>' +
      '<div class="panel"><div class="panel-head"><h2>All campaigns</h2><span class="spacer"></span>' +
      '<button class="btn primary" data-action="new-campaign">New campaign</button></div>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th class="num">Priority</th><th class="num">Weight</th><th>Schedule</th><th>Caps / day</th><th>Zones</th><th>Status</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>'
    );
  }

  function viewBanners() {
    var campaignName = {};
    state.campaigns.forEach(function (campaign) {
      campaignName[campaign.id] = campaign.name;
    });
    var rows = state.banners.length
      ? state.banners
          .map(function (banner) {
            var creative;
            if (banner.type === 'image') {
              creative = banner.image_key
                ? '<img class="thumb" src="/i/' + banner.id + '" alt="">'
                : badge('no image', 'danger');
            } else {
              creative = '<span class="muted small">' + esc(banner.type) + '</span>';
            }
            return (
              '<tr><td>#' + banner.id + '</td><td>' + esc(banner.name) + '</td>' +
              '<td>' + esc(campaignName[banner.campaign_id] || banner.campaign_id) + '</td>' +
              '<td>' + esc(banner.type) + '</td>' +
              '<td class="small">' + banner.width + '×' + banner.height + '<div class="muted">' + esc(banner.target_url) + '</div></td>' +
              '<td>' + creative + '</td>' +
              '<td>' + badge(banner.status, banner.status === 'active' ? 'ok' : 'warn') + '</td>' +
              '<td class="actions">' +
              '<button class="btn small" data-action="preview-banner" data-id="' + banner.id + '">Preview</button> ' +
              (banner.type === 'image'
                ? '<button class="btn small" data-action="upload-banner" data-id="' + banner.id + '">Upload</button> '
                : '') +
              '<button class="btn small" data-action="edit-banner" data-id="' + banner.id + '">Edit</button> ' +
              '<button class="btn small danger" data-action="delete-banner" data-id="' + banner.id + '">Delete</button>' +
              '</td></tr>'
            );
          })
          .join('')
      : '<tr><td colspan="8" class="muted">No banners yet.</td></tr>';

    return (
      '<h1>Banners</h1><p class="muted small">Image creatives are stored in the R2 bucket. HTML5 creatives run in a sandboxed frame; text creatives are plain text.</p>' +
      '<div class="panel"><div class="panel-head"><h2>All banners</h2><span class="spacer"></span>' +
      '<button class="btn primary" data-action="new-banner">New banner</button></div>' +
      '<table><thead><tr><th>ID</th><th>Name</th><th>Campaign</th><th>Type</th><th>Target</th><th>Creative</th><th>Status</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>'
    );
  }

  function viewReport() {
    var query = state.reportQuery;
    var data = state.report;
    var body = data
      ? '<div class="panel"><h2>By day</h2>' + chart(data.byDay) + '</div>' +
        '<div class="panel"><div class="panel-head"><h2>By ' + esc(data.group) + '</h2><span class="spacer"></span>' +
        '<button class="btn" data-action="export-csv">Download CSV</button></div>' +
        groupTable(data.byGroup, data.group) + '</div>'
      : '<div class="panel"><p class="muted">Choose a range and run the report.</p></div>';

    return (
      '<h1>Report</h1>' +
      '<div class="panel"><div class="row">' +
      '<div><label class="muted small">From</label><input type="date" id="report-from" value="' + esc(query.from) + '"></div>' +
      '<div><label class="muted small">To</label><input type="date" id="report-to" value="' + esc(query.to) + '"></div>' +
      '<div><label class="muted small">Group by</label><select id="report-group">' +
      ['banner', 'campaign', 'zone', 'site'].map(function (group) {
        return '<option value="' + group + '"' + (query.group === group ? ' selected' : '') + '>' + group + '</option>';
      }).join('') +
      '</select></div>' +
      '<button class="btn primary" data-action="run-report">Run report</button>' +
      '</div></div>' + body
    );
  }

  // ------------------------------------------------------------------ render
  function render() {
    renderTabs();
    var view = currentView();
    try {
      if (view === 'sites') main.innerHTML = viewSites();
      else if (view === 'zones') main.innerHTML = viewZones();
      else if (view === 'campaigns') main.innerHTML = viewCampaigns();
      else if (view === 'banners') main.innerHTML = viewBanners();
      else if (view === 'report') main.innerHTML = viewReport();
      else main.innerHTML = viewDashboard();
    } catch (error) {
      main.innerHTML = errorPanel(error.message);
    }
  }

  function refresh(showToast) {
    return Promise.all([
      api('/api/admin/me'),
      api('/api/admin/overview?days=14'),
      api('/api/admin/zones'),
      api('/api/admin/campaigns'),
      api('/api/admin/banners'),
      api('/api/admin/sites'),
    ])
      .then(function (results) {
        state.me = results[0];
        state.overview = results[1];
        state.zones = results[2].zones;
        state.campaigns = results[3].campaigns;
        state.banners = results[4].banners;
        state.sites = results[5].sites;
        who.textContent = state.me.identity.email || state.me.identity.sub;
        envTag.textContent = state.me.environment + (state.me.identity.via === 'dev' ? ' · dev auth' : '');
        if (!state.reportQuery.from) {
          state.reportQuery.from = state.overview.range.from;
          state.reportQuery.to = state.overview.range.to;
        }
        render();
        if (showToast) toast('Saved');
      })
      .catch(function (error) {
        who.textContent = '';
        main.innerHTML = errorPanel(error.message);
      });
  }

  function zoneById(id) {
    for (var i = 0; i < state.zones.length; i++) if (state.zones[i].id === id) return state.zones[i];
    return null;
  }
  function siteById(id) {
    for (var i = 0; i < state.sites.length; i++) if (state.sites[i].id === id) return state.sites[i];
    return null;
  }
  function campaignById(id) {
    for (var i = 0; i < state.campaigns.length; i++) if (state.campaigns[i].id === id) return state.campaigns[i];
    return null;
  }
  function bannerById(id) {
    for (var i = 0; i < state.banners.length; i++) if (state.banners[i].id === id) return state.banners[i];
    return null;
  }

  // ----------------------------------------------------------------- actions
  var ZONE_FIELDS = [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'site_id', label: 'Site', type: 'select', options: [] },
    { name: 'slug', label: 'Slug (optional)', type: 'text' },
    { name: 'width', label: 'Width (px)', type: 'number' },
    { name: 'height', label: 'Height (px)', type: 'number' },
    { name: 'mode', label: 'Rendering mode', type: 'select', options: [
      { value: 'iframe', label: 'iframe (default, safest)' },
      { value: 'inline', label: 'inline (image + text creatives only)' },
    ] },
    { name: 'auto_height', label: 'Let the ad set its own height', type: 'checkbox' },
    { name: 'page_allow', label: 'Allow on pages', type: 'textarea', full: true, hint: 'One pattern per line: example.com, *.example.com, /blog*, https://a.com/x*. Empty = any page.' },
    { name: 'page_block', label: 'Block on pages', type: 'textarea', full: true, hint: 'Same pattern syntax. Block always wins.' },
    { name: 'fallback_html', label: 'Fallback HTML', type: 'textarea', full: true, hint: 'Shown when no campaign is eligible. Rendered in a sandboxed frame.' },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ];

  function zoneFields() {
    var siteOptions = [{ value: '', label: '— no site —' }].concat(
      state.sites.map(function (site) {
        return {
          value: site.id,
          label: site.name + (site.domain ? ' · ' + site.domain : ''),
        };
      }),
    );
    return ZONE_FIELDS.map(function (field) {
      if (field.name !== 'site_id') return field;
      return { name: 'site_id', label: field.label, type: 'select', options: siteOptions };
    });
  }

  var SITE_FIELDS = [
    { name: 'name', label: 'Site name', type: 'text' },
    { name: 'domain', label: 'Domain', type: 'text', hint: 'example.com — used for labelling and reporting only.' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
    { name: 'active', label: 'Active', type: 'checkbox' },
  ];

  var CAMPAIGN_FIELDS = [
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'advertiser', label: 'Advertiser', type: 'text' },
    { name: 'priority', label: 'Priority (0 highest)', type: 'number' },
    { name: 'weight', label: 'Weight', type: 'number' },
    { name: 'starts_at', label: 'Starts (YYYY-MM-DD)', type: 'date' },
    { name: 'ends_at', label: 'Ends (YYYY-MM-DD)', type: 'date' },
    { name: 'imp_cap', label: 'Impression cap / day (0 = none)', type: 'number' },
    { name: 'click_cap', label: 'Click cap / day (0 = none)', type: 'number' },
    { name: 'status', label: 'Status', type: 'select', options: [
      { value: 'active', label: 'active' },
      { value: 'paused', label: 'paused' },
      { value: 'draft', label: 'draft' },
      { value: 'finished', label: 'finished' },
    ] },
    { name: 'page_allow', label: 'Allow on pages', type: 'textarea', full: true, hint: 'Limit this campaign to matching pages, independent of its zones. One pattern per line: /qld/* (every QLD suburb), /qld/victoria-point* (one suburb), localdentists.au/*/*. Empty = any page.' },
    { name: 'page_block', label: 'Block on pages', type: 'textarea', full: true, hint: 'Same syntax. Block always wins.' },
    { name: 'zoneIds', label: 'Zones', type: 'zones', full: true, hint: 'A campaign only serves in the zones it is linked to.' },
  ];

  var BANNER_FIELDS = [
    { name: 'campaign_id', label: 'Campaign', type: 'select', options: [] },
    { name: 'name', label: 'Name', type: 'text' },
    { name: 'type', label: 'Type', type: 'select', options: [
      { value: 'image', label: 'image (upload to R2)' },
      { value: 'html', label: 'html (HTML5 creative, sandboxed)' },
      { value: 'text', label: 'text (plain text)' },
    ] },
    { name: 'width', label: 'Width (px)', type: 'number' },
    { name: 'height', label: 'Height (px)', type: 'number' },
    { name: 'weight', label: 'Weight', type: 'number' },
    { name: 'status', label: 'Status', type: 'select', options: [
      { value: 'active', label: 'active' },
      { value: 'paused', label: 'paused' },
      { value: 'draft', label: 'draft' },
    ] },
    { name: 'target_url', label: 'Click-through URL', type: 'url', full: true, hint: 'Where a click goes. Stored server-side; the click endpoint never redirects to a request-supplied URL.' },
    { name: 'alt', label: 'Alt text', type: 'text', full: true },
    { name: 'html', label: 'HTML / text creative', type: 'textarea', full: true, hint: 'Macros: {{CLICK_URL}} {{CACHEBUSTER}} {{AD_WIDTH}} {{AD_HEIGHT}} {{ZONE_ID}} {{BANNER_ID}} {{PAGE_URL}}' },
  ];

  function bannerFieldOptions() {
    return state.campaigns.map(function (campaign) {
      return { value: campaign.id, label: '#' + campaign.id + ' · ' + campaign.name };
    });
  }

  main.addEventListener('click', function (event) {
    var button = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-action');
    var id = parseInt(button.getAttribute('data-id') || '0', 10);

    if (action === 'new-site') {
      openModal('New site', SITE_FIELDS, { active: 1 }, function (values) {
        return api('/api/admin/sites', { method: 'POST', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'edit-site') {
      var site = siteById(id);
      if (!site) return;
      openModal('Site #' + id, SITE_FIELDS, site, function (values) {
        return api('/api/admin/sites/' + id, { method: 'PUT', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'delete-site') {
      if (!window.confirm('Delete site #' + id + '? Its zones stay and become unassigned; their embed code keeps working.')) return;
      api('/api/admin/sites/' + id, { method: 'DELETE' }).then(function () { refresh(true); }).catch(function (error) { toast(error.message, true); });
      return;
    }
    if (action === 'site-zones') {
      var siteZones = state.zones.filter(function (zone) { return zone.site_id === id; });
      var siteExtra = document.getElementById('site-extra');
      if (!siteExtra) return;
      var siteRow = siteById(id);
      siteExtra.innerHTML =
        '<div class="panel"><div class="panel-head"><h2>Zones on ' +
        esc(siteRow ? siteRow.name : '#' + id) + '</h2><span class="spacer"></span>' +
        '<button class="btn small primary" data-action="new-zone-in-site" data-id="' + id + '">New zone here</button></div>' +
        (siteZones.length
          ? '<table><thead><tr><th>ID</th><th>Name</th><th>Size</th><th>Status</th><th></th></tr></thead><tbody>' +
            siteZones.map(function (zone) {
              return '<tr><td>#' + zone.id + '</td><td>' + esc(zone.name) + '</td>' +
                '<td>' + zone.width + '×' + zone.height + '</td>' +
                '<td>' + (zone.active ? badge('active', 'ok') : badge('inactive', 'warn')) + '</td>' +
                '<td class="actions"><button class="btn small" data-action="edit-zone" data-id="' + zone.id + '">Edit</button></td></tr>';
            }).join('') + '</tbody></table>'
          : '<p class="muted small">No zones assigned yet.</p>') +
        '</div>';
      siteExtra.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }
    if (action === 'new-zone' || action === 'new-zone-in-site') {
      openModal('New zone', zoneFields(), {
        width: 728,
        height: 90,
        mode: 'iframe',
        active: 1,
        site_id: action === 'new-zone-in-site' ? id : '',
      }, function (values) {
        return api('/api/admin/zones', { method: 'POST', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'edit-zone') {
      var zone = zoneById(id);
      if (!zone) return;
      openModal('Zone #' + id, zoneFields(), zone, function (values) {
        return api('/api/admin/zones/' + id, { method: 'PUT', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'delete-zone') {
      if (!window.confirm('Delete zone #' + id + '? Its campaign links are removed too.')) return;
      api('/api/admin/zones/' + id, { method: 'DELETE' }).then(function () { refresh(true); }).catch(function (error) { toast(error.message, true); });
      return;
    }
    if (action === 'snippet') {
      var zoneForSnippet = zoneById(id);
      if (!zoneForSnippet) return;
      api('/api/admin/zones/' + id + '/snippet').then(function (data) {
        var extra = document.getElementById('zone-extra');
        if (!extra) return;
        extra.innerHTML =
          '<div class="panel"><div class="panel-head"><h2>Code for zone #' + id + ' · ' + esc(zoneForSnippet.name) + '</h2>' +
          '<span class="spacer"></span><button class="btn small" data-action="copy-snippet" data-id="' + id + '">Copy</button></div>' +
          '<pre class="snippet" id="snippet-text">' + esc(data.snippet) + '</pre>' +
          '<p class="muted small">Paste this where the ad should appear. The loader only touches the element you point it at.</p></div>';
        extra.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }).catch(function (error) { toast(error.message, true); });
      return;
    }
    if (action === 'copy-snippet') {
      var pre = document.getElementById('snippet-text');
      if (!pre) return;
      selectText(pre); // so Ctrl+C works even if every copy path is blocked
      copyText(pre.textContent || '').then(function (copied) {
        toast(copied ? 'Code copied to clipboard' : 'Clipboard blocked - the code is selected, press Ctrl+C', !copied);
      });
      return;
    }
    if (action === 'preview-zone') {
      var previewZone = zoneById(id);
      if (!previewZone) return;
      var extra2 = document.getElementById('zone-extra');
      if (!extra2) return;
      var w = previewZone.width || 728;
      var h = previewZone.height || 90;
      var previewUrl = '/api/admin/preview?z=' + id + '&w=' + w + '&h=' + h + '&cb=' + Date.now() + (devTokenQuery() ? '&' + devTokenQuery() : '');
      extra2.innerHTML =
        '<div class="panel"><h2>Preview · zone #' + id + '</h2>' +
        '<iframe class="preview-frame" style="height:' + (h + 24) + 'px;max-width:' + Math.max(w + 24, 320) + 'px" ' +
        'src="' + previewUrl + '"></iframe>' +
        '<p class="muted small">Previews do not count as impressions.</p>' +
        '<div class="row" style="margin-top:.5rem"><button class="btn small" data-action="reload-preview" data-id="' + id + '">Reload</button></div></div>';
      return;
    }
    if (action === 'reload-preview') {
      var frame = document.querySelector('#zone-extra iframe');
      if (frame) frame.src = frame.src.replace(/&cb=\d+/, '') + '&cb=' + Date.now();
      return;
    }
    if (action === 'new-campaign') {
      openModal('New campaign', CAMPAIGN_FIELDS, { priority: 5, weight: 1, status: 'active', zoneIds: [] }, function (values) {
        return saveCampaign('/api/admin/campaigns', 'POST', values);
      });
      return;
    }
    if (action === 'edit-campaign') {
      var campaign = campaignById(id);
      if (!campaign) return;
      openModal('Campaign #' + id, CAMPAIGN_FIELDS, campaign, function (values) {
        return saveCampaign('/api/admin/campaigns/' + id, 'PUT', values);
      });
      return;
    }
    if (action === 'delete-campaign') {
      if (!window.confirm('Delete campaign #' + id + ' and its banners?')) return;
      api('/api/admin/campaigns/' + id, { method: 'DELETE' }).then(function () { refresh(true); }).catch(function (error) { toast(error.message, true); });
      return;
    }
    if (action === 'new-banner') {
      if (!state.campaigns.length) return toast('Create a campaign first', true);
      var fields = BANNER_FIELDS.map(function (field) {
        return field.name === 'campaign_id' ? { name: 'campaign_id', label: field.label, type: 'select', options: bannerFieldOptions() } : field;
      });
      openModal('New banner', fields, { campaign_id: state.campaigns[0].id, type: 'image', width: 728, height: 90, weight: 1, status: 'active' }, function (values) {
        return api('/api/admin/banners', { method: 'POST', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'edit-banner') {
      var banner = bannerById(id);
      if (!banner) return;
      var editFields = BANNER_FIELDS.map(function (field) {
        return field.name === 'campaign_id' ? { name: 'campaign_id', label: field.label, type: 'select', options: bannerFieldOptions() } : field;
      });
      openModal('Banner #' + id, editFields, banner, function (values) {
        return api('/api/admin/banners/' + id, { method: 'PUT', json: values }).then(function () { return refresh(true); });
      });
      return;
    }
    if (action === 'delete-banner') {
      if (!window.confirm('Delete banner #' + id + '? Its creative is removed from the bucket.')) return;
      api('/api/admin/banners/' + id, { method: 'DELETE' }).then(function () { refresh(true); }).catch(function (error) { toast(error.message, true); });
      return;
    }
    if (action === 'upload-banner') {
      openModal('Upload creative · banner #' + id, [
        { name: 'file', label: 'Image file', type: 'file', full: true, hint: 'PNG, JPEG, GIF or WebP, up to 2 MB. The file type is verified from its bytes.' },
      ], null, function (values) {
        if (!values.file || !values.file.size) throw new Error('Choose a file first');
        var body = new FormData();
        body.append('file', values.file);
        return fetch('/api/admin/banners/' + id + '/creative', {
          method: 'POST',
          headers: adminHeaders(),
          credentials: 'same-origin',
          body: body,
        }).then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok || data.ok === false) throw new Error(data.error || 'Upload failed');
            return refresh(true);
          });
        });
      });
      return;
    }
    if (action === 'preview-banner') {
      window.open('/api/admin/banner-preview/' + id + (devTokenQuery() ? '?' + devTokenQuery() : ''), '_blank', 'noopener');
      return;
    }
    if (action === 'run-report') {
      var from = document.getElementById('report-from').value;
      var to = document.getElementById('report-to').value;
      var group = document.getElementById('report-group').value;
      state.reportQuery = { from: from, to: to, group: group };
      api('/api/admin/stats?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&group=' + encodeURIComponent(group))
        .then(function (data) {
          state.report = data;
          render();
        })
        .catch(function (error) {
          toast(error.message, true);
        });
      return;
    }
    if (action === 'export-csv') {
      if (!state.report) return;
      var lines = ['day,impressions,clicks'];
      state.report.byDay.forEach(function (row) {
        lines.push([row.day, row.impressions, row.clicks].join(','));
      });
      lines.push('');
      lines.push(state.report.group + ',impressions,clicks,ctr');
      state.report.byGroup.forEach(function (row) {
        lines.push(['"' + String(row.label || row.key).replace(/"/g, '""') + '"', row.impressions, row.clicks, ctr(row.impressions, row.clicks)].join(','));
      });
      var blob = new Blob([lines.join('\n')], { type: 'text/csv' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'adserver-report-' + state.reportQuery.from + '-to-' + state.reportQuery.to + '.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
  });

  window.addEventListener('hashchange', render);
  refresh(false);
})();
