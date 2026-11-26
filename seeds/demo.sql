-- Demo data for local development only. NOT a migration — it is never applied
-- automatically. Run: npm run db:seed:local
--
-- Creates one zone (728x90 leaderboard) with two campaigns/banners so the
-- selection engine has something to choose between.

INSERT INTO zones (id, name, slug, width, height, mode, page_allow, page_block)
VALUES (1, 'Demo - Site leaderboard', 'demo-leaderboard', 728, 90, 'iframe', '', '')
ON CONFLICT(id) DO NOTHING;

INSERT INTO campaigns (id, name, advertiser, priority, weight, status)
VALUES (1, 'Demo - Brand awareness', 'Demo Advertiser', 5, 1, 'active')
ON CONFLICT(id) DO NOTHING;

INSERT INTO campaigns (id, name, advertiser, priority, weight, status)
VALUES (2, 'Demo - House ad', 'House', 10, 1, 'active')
ON CONFLICT(id) DO NOTHING;

INSERT INTO campaign_zones (campaign_id, zone_id) VALUES (1, 1), (2, 1)
ON CONFLICT DO NOTHING;

INSERT INTO banners (id, campaign_id, name, type, width, height, alt, html, target_url, status)
VALUES (1, 1, 'Demo text banner A', 'text', 728, 90, '',
        '<strong>Advertise here</strong> — reach local customers with a 728x90 leaderboard.',
        'https://example.com/', 'active')
ON CONFLICT(id) DO NOTHING;

INSERT INTO banners (id, campaign_id, name, type, width, height, alt, html, target_url, status)
VALUES (2, 2, 'Demo text banner B', 'text', 728, 90, '',
        '<strong>Your ad could be here.</strong> Book a campaign.',
        'https://example.org/', 'active')
ON CONFLICT(id) DO NOTHING;
