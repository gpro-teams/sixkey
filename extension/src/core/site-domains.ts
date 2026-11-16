// Which domains may be registered for an account, and the choices offered for the page the user is on (PHASE0X-PLAN
// B2). The popup imports this module only dynamically, when the user registers a site, so the table below is not part
// of the popup's counted bundle. It imports nothing: a lazy chunk that shared modules the popup already has would make
// the bundler split them out of the shared chunk. How registered domains match pages is in match.ts.
//
// Sixkey does not ship the public suffix list (335 KB, changes every week; ux-study §2.10). Instead, never accepted:
// - a single label ("com", "localhost", "intranet");
// - a shared suffix, under which unrelated people run their own sites: a country's generic second level (co.uk,
//   com.cn, gov.br: the rule below), or one of about 90 others in the table (or.jp, in.th, github.io, vercel.app);
// - any name above a shared suffix: amazonaws.com would cover every bucket under s3.amazonaws.com.
// A shared name that is in neither (a SaaS service with one subdomain per customer, say) is the known gap. It is why
// the choice offered first is the page's own host, not its shortest parent: on acme.example-saas.com, registering
// example-saas.com would also mark every other customer's subdomain, an attacker's included, as "This site".

/** A two-letter country domain under a generic word, the way most registries split theirs: co.uk, com.au, gov.cn. */
const COUNTRY_GENERIC =
  /^(?:co|com|net|org|gov|govt|edu|ac|or|ne|go|gob|mil|nom|ltd|plc|sch|gen|firm|ind|idv)\.[a-z]{2}$/;

/** Shared suffixes the rule above does not cover: other registry levels, and hosting platforms' public suffixes. */
const TABLE = new Set(
  `
in.th lg.jp gr.jp ad.jp ed.jp re.kr pe.kr id.au asn.au me.uk web.id web.za
github.io githubusercontent.com gitlab.io bitbucket.io codeberg.page
vercel.app now.sh netlify.app pages.dev workers.dev r2.dev trycloudflare.com
web.app firebaseapp.com appspot.com googleusercontent.com cloudfunctions.net run.app translate.goog blogspot.com
herokuapp.com onrender.com fly.dev deno.dev glitch.me repl.co replit.dev surge.sh csb.app
amplifyapp.com cloudfront.net elasticbeanstalk.com s3.amazonaws.com
azurewebsites.net azurestaticapps.net cloudapp.net blob.core.windows.net web.core.windows.net
ondigitalocean.app digitaloceanspaces.com pythonanywhere.com 000webhostapp.com
myshopify.com wixsite.com webflow.io readthedocs.io gitbook.io neocities.org
ngrok.io ngrok-free.app duckdns.org dyndns.org ddns.net hopto.org zapto.org js.org eu.org
co.com com.de com.se us.com uk.com eu.com cn.com jpn.com za.com br.com ru.com sa.com gb.net
com.ru msk.ru spb.ru org.ru net.ru com.ua kiev.ua
`
    .trim()
    .split(/\s+/),
);

/** The same test as match.ts's isIpHost (repeated so this module imports nothing; site-domains.test checks they agree). */
const isIp = (h: string) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.startsWith("[");

/** True when `d` (a canonical host name) may not be registered: a single label, a shared suffix, or a name above one. */
export function isShared(d: string): boolean {
  if (isIp(d)) return false;
  if (!d.includes(".") || COUNTRY_GENERIC.test(d) || TABLE.has(d)) return true;
  for (const s of TABLE) if (s.endsWith("." + d)) return true;
  return false;
}

/**
 * What may be registered for the page at `host` (canonical, as match.ts's hostOf gives it): the host itself, then each
 * parent in turn, up to (not including) the first that is shared. An IP address offers only itself; a single label, or
 * a host that is itself shared, nothing.
 */
export function domainChoices(host: string): string[] {
  if (isIp(host)) return [host];
  const out: string[] = [];
  for (let d = host; !isShared(d); d = d.slice(d.indexOf(".") + 1)) out.push(d);
  return out;
}

/** The choice to start with: the host itself, or its parent when the host only adds "www.". */
export const preferredChoice = (choices: string[]): string | undefined =>
  choices[0]?.startsWith("www.") && choices[1] === choices[0].slice(4) ? choices[1] : choices[0];
