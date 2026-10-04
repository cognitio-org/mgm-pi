#!/usr/bin/env python3
"""Writes public/privacy/index.html and public/terms/index.html from the text below.

The pages share index.html's <head> theme script byte for byte, so the CSP hash in
security-headers.conf covers them too (test/legal.test.mjs checks it). Edit the text here and
re-run: python3 outfitter/landing/tools/legal-pages.py
Placeholders the owner must fill are <mark class="todo">[…]</mark>.
"""
import pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent / "public"
INDEX = (ROOT / "index.html").read_text()
THEME = INDEX[INDEX.index("<script>"):INDEX.index("</script>") + len("</script>")]
BRAND = INDEX[INDEX.index('<a class="brand"'):INDEX.index("</a>", INDEX.index('<a class="brand"')) + 4]
UPDATED = "5 October 2026"

def todo(text): return f'<mark class="todo">[{text}]</mark>'
ENTITY = todo("Legal entity name")
ADDRESS = todo("Registered address")
EMAIL = todo("privacy@ contact email")
LAW = todo("Governing law and courts, e.g. the laws of Croatia, courts of Zagreb")

def page(title, description, body):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Kernal</title>
<meta name="description" content="{description}">
<meta name="theme-color" content="#302870" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f1ebdd" media="(prefers-color-scheme: light)">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/style.css">
{THEME}
</head>
<body>
<div class="border">
  <main class="screen">
    <header class="topbar">
      {BRAND}
    </header>
    <article class="legal">
{body}
    </article>
    <footer class="foot">
      <a href="/">KERNAL.ONE</a>
      <a href="/privacy/">PRIVACY</a>
      <a href="/terms/">TERMS</a>
      <span class="ok">READY.</span>
    </footer>
  </main>
</div>
</body>
</html>
"""

PRIVACY = f"""
<h1>Privacy Policy</h1>
<p class="meta">Last updated {UPDATED}</p>

<div class="summary">
  <p><strong>In short:</strong> we collect what we need to run Kernal and Outfitter for invited people:
  your Google email, what you and your agents do in Outfitter, and the keys you choose to store. We don't
  sell personal data, don't run advertising or analytics trackers, and send data to other companies only
  to provide the service (the cloud, the database and the AI models your agents use).</p>
</div>

<h2>1. Who we are</h2>
<p>Kernal and Outfitter (together, “the Service”) are run by {ENTITY}, {ADDRESS} (“we”, “us”). We are the
controller of the personal data described here. Questions and requests: {EMAIL}.</p>

<h2>2. What this policy covers</h2>
<ul>
  <li>the website <strong>kernal.one</strong>;</li>
  <li><strong>Outfitter</strong>, the web app at app.kernal.one and its API (link.kernal.one), including agent
    sandboxes (“Drives”) and preview links on kernal.run;</li>
  <li><strong>Kernal</strong>, the coding agent you run on your own computer, where it connects to our services.</li>
</ul>
<p>Outfitter is currently available by invitation only.</p>

<h2>3. What we collect</h2>
<h3>Account and sign-in</h3>
<ul>
  <li>Your <strong>email address</strong>, from Google sign-in. We don't receive your Google password and we don't
    store your Google account ID.</li>
  <li>When you sign Kernal in on a computer: a <strong>device record</strong> (the device's name and platform, and
    the Kernal version). Device and API tokens are stored only as one-way hashes; you can see and revoke them.</li>
  <li>Optional profile details an administrator may add for commit attribution: display name, GitHub username and
    GitHub no-reply email.</li>
  <li>Your settings and named profiles (for example your default model or voice preferences).</li>
</ul>
<h3>What you and your agents do</h3>
<ul>
  <li><strong>Agent sessions:</strong> your prompts, the agents' replies, tool calls and their results, files and
    code the agents read or write in their sandboxes, messages between agents, and browser captures you request.
    This can include anything you put in your repositories or prompts, so please don't paste data you aren't
    allowed to share.</li>
  <li><strong>Search index:</strong> sessions are split into chunks for search. Secret-looking strings are redacted
    before indexing.</li>
  <li><strong>Agent memory</strong> (where enabled): facts the agents keep between sessions. On a laptop, memory
    recording is off unless you turn it on.</li>
  <li><strong>Repository access:</strong> agents work in GitHub repositories you connect, through a GitHub App or a
    token you provide.</li>
</ul>
<h3>Keys and secrets you give us</h3>
<ul>
  <li>Personal provider API keys (for example an OpenRouter key) you choose to save to your account. They are
    stored in Google Secret Manager, delivered only to your own signed-in devices, and not shown again in the web app.</li>
  <li>Keys kept only in Kernal on your computer (its <code>.env</code> file) stay on your computer.</li>
</ul>
<h3>Usage and cost</h3>
<ul>
  <li>AI model usage and cost per person and per agent: model names, token counts, spend and budgets. Your
    router key is linked to your email so spend can be attributed to you.</li>
  <li>Voice usage totals, under a pseudonymous ID derived from your email.</li>
</ul>
<h3>Voice</h3>
<p>If you use voice input, audio streams from your browser or computer directly to our speech-to-text
provider; we don't store the audio.</p>
<h3>Technical data</h3>
<ul>
  <li>Server logs kept by our cloud provider (for example request times, paths and IP addresses) for security
    and operations.</li>
  <li>Error reports, only if error reporting is switched on (it is off by default). Request bodies and headers
    are removed, and Kernal strips secrets from errors before sending. If an administrator turns on agent
    tracing, prompts and outputs may be included in redacted form. On the web app, an error may include a
    replay of the page session with text and inputs masked.</li>
</ul>

<h2>4. Cookies and local storage</h2>
<p>We use no advertising or analytics cookies.</p>
<ul>
  <li><strong>Google sign-in cookies</strong>, set by Google's Identity-Aware Proxy, keep you signed in to the
    web app. They are strictly necessary.</li>
  <li><strong><code>kernal_welcome</code></strong>: your first name, so kernal.one can greet you (180 days).</li>
  <li><strong>Local storage</strong> in your browser for preferences: theme, sound, the BASIC programs you save on
    kernal.one, tour progress and similar. These never leave your browser.</li>
</ul>

<h2>5. How we use it, and our legal bases</h2>
<div class="table-wrap"><table>
  <tr><th>Purpose</th><th>Legal basis (GDPR)</th></tr>
  <tr><td>Signing you in, running your agents and sessions, storing your settings and keys</td><td>Performing our contract with you</td></tr>
  <tr><td>Tracking and limiting AI spend per person and agent</td><td>Contract; our legitimate interest in controlling costs</td></tr>
  <tr><td>Security, abuse prevention, debugging and error reports</td><td>Legitimate interest in a safe, working Service</td></tr>
  <tr><td>Legal obligations, and responding to lawful requests</td><td>Legal obligation</td></tr>
</table></div>
<p>We don't use your data for advertising, we don't sell or rent it, and we don't use your content to train
our own models.</p>

<h2>6. Who we share it with</h2>
<p>Only the service providers below, acting for us under their data processing terms, and only for the purposes
above:</p>
<div class="table-wrap"><table>
  <tr><th>Provider</th><th>What for</th><th>Location</th></tr>
  <tr><td>Google Cloud</td><td>Sign-in (Identity-Aware Proxy), hosting (Cloud Run, Kubernetes sandboxes), secrets, task queues, logs</td><td>United States (us-central1)</td></tr>
  <tr><td>MongoDB Atlas</td><td>Database, agent memory, search embeddings</td><td>United States (Google Cloud, Iowa)</td></tr>
  <tr><td>AI model providers, through our model router</td><td>Prompts and context are sent to the model that answers them (for example Anthropic, Google or OpenAI models)</td><td>Mainly United States</td></tr>
  <tr><td>OpenRouter</td><td>Only if you add your own OpenRouter key: prompts to the models you pick</td><td>United States</td></tr>
  <tr><td>GitHub</td><td>Access to the repositories you connect; commits made by agents</td><td>United States</td></tr>
  <tr><td>Deepgram</td><td>Speech-to-text, only when you use voice</td><td>United States</td></tr>
  <tr><td>ngrok</td><td>Preview links to apps running in a sandbox (kernal.run)</td><td>United States</td></tr>
  <tr><td>Sentry</td><td>Error reports, only when switched on</td><td>United States</td></tr>
</table></div>
<p>AI providers process prompts under their own API terms, which generally don't allow training on API data.
We may also disclose data if the law requires it, or to protect the rights and safety of our users or others.
If the Service changes hands, data would transfer under this policy.</p>

<h2>7. International transfers</h2>
<p>We host in the United States. Where data leaves the European Economic Area or the UK, we rely on the
providers' Standard Contractual Clauses or the EU–US Data Privacy Framework.</p>

<h2>8. How long we keep it</h2>
<ul>
  <li><strong>Sessions</strong> are kept until you delete them. Deleting (“formatting”) a session erases its
    transcript, runs, search index, memory sessions and browser data. A small record that it was deleted, and by
    whom, remains.</li>
  <li><strong>Messages between agents and short-lived approvals</strong> expire automatically.</li>
  <li><strong>Your account, settings, keys and usage records</strong> are kept while you have access. When access
    ends, or when you ask, we delete or anonymise them within 30 days, except what we must keep by law.</li>
  <li><strong>Logs and error reports</strong> are kept for the providers' standard periods (typically 30 to 90 days).</li>
</ul>

<h2>9. Security</h2>
<p>Traffic is encrypted (HTTPS only). The web app sits behind Google sign-in with an allow-list. Secrets live
in Secret Manager and reach sandboxes over authenticated connections, never in plain configuration. Tokens are
stored hashed, and each agent sandbox is isolated. No system is perfectly secure; we will tell you without
undue delay if a breach affects your data.</p>

<h2>10. Your rights</h2>
<p>Depending on where you live (for example under the GDPR or UK GDPR), you can ask to access, correct, delete,
restrict or port your data, and object to processing based on legitimate interests. Write to {EMAIL}; we
answer within one month. You can also delete sessions and revoke devices and tokens yourself in the web app. If
you are in the EEA or UK, you may complain to your data protection authority.</p>
<p>California residents: we don't sell or share personal information for cross-context behavioural
advertising.</p>

<h2>11. Children</h2>
<p>The Service is for professionals and isn't directed at anyone under 16. We don't knowingly collect their data.</p>

<h2>12. Changes</h2>
<p>We'll update this page when our practices change, and tell signed-in users about material changes before they
take effect. If we add new kinds of data, for example financial data for a banking integration, we'll update
this policy and ask for consent where required before collecting it.</p>

<h2>13. Contact</h2>
<p>{ENTITY}, {ADDRESS}. Email: {EMAIL}.</p>
"""

TERMS = f"""
<h1>Terms of Use</h1>
<p class="meta">Last updated {UPDATED}</p>

<div class="summary">
  <p><strong>In short:</strong> Outfitter is an invitation-only service in active development. Use it lawfully,
  keep your access to yourself, review what the agents produce before you rely on it, and know that we can change
  or stop the Service. Your code and content stay yours.</p>
</div>

<h2>1. Agreement</h2>
<p>These terms are an agreement between you and {ENTITY}, {ADDRESS} (“we”, “us”), for kernal.one, the Outfitter
web app and API, its agent sandboxes and preview links, and the Kernal agent where it connects to them (the
“Service”). By using the Service you accept these terms and our <a href="/privacy/">Privacy Policy</a>. If you use
it for an organisation, you confirm you may accept these terms for it.</p>

<h2>2. Access</h2>
<ul>
  <li>Outfitter is invitation-only. We decide who gets access and may change or withdraw it.</li>
  <li>You sign in with your own Google account. Keep your account, devices and tokens secure, don't share them,
    and tell us at {EMAIL} if you think they've been misused.</li>
  <li>You must be at least 16, and old enough to enter a contract where you live.</li>
</ul>

<h2>3. The Service is in development</h2>
<p>Features change often and may be unavailable, limited or removed. We may set usage limits and budgets, for
example on AI spend per person or agent, and pause agents that exceed them.</p>

<h2>4. Acceptable use</h2>
<p>Don't use the Service to:</p>
<ul>
  <li>break the law or infringe anyone's rights, including intellectual property and privacy;</li>
  <li>access systems, repositories or data you aren't authorised to access;</li>
  <li>build or spread malware, attack or probe systems without permission, or send spam;</li>
  <li>get around our security, sign-in, limits or budgets, or interfere with other users' agents;</li>
  <li>mine cryptocurrency, or use sandboxes as general-purpose hosting unrelated to your work;</li>
  <li>generate content that violates the usage policies of the AI model providers you use through the Service;</li>
  <li>process special categories of personal data, or payment card data, unless we have agreed to it in writing.</li>
</ul>
<p>Public preview links make what runs in your sandbox reachable by anyone with the link. You are responsible for
what you expose.</p>

<h2>5. Your content</h2>
<ul>
  <li>You keep all rights in your code, prompts, files and other content, and in the output the agents produce
    for you, as far as the law allows.</li>
  <li>You give us a limited licence to host, copy, process and transmit your content only as needed to run the
    Service for you, including sending it to the AI models and tools your agents use.</li>
  <li>You confirm you have the rights to the content and repositories you bring to the Service.</li>
</ul>

<h2>6. AI output</h2>
<p>Agents use AI models and can be wrong, insecure or incomplete. They can change files, run commands and commit
to repositories you connect. Review their work before you merge, deploy or rely on it. You are responsible for how
you use it.</p>

<h2>7. Third-party services and keys</h2>
<p>The Service works with third parties such as Google, GitHub, MongoDB, AI model providers, OpenRouter,
Deepgram and ngrok. Their terms apply to your use of them. If you add your own API keys, you are responsible for
the costs and the provider's terms on those keys.</p>

<h2>8. Fees</h2>
<p>The Service is currently provided without charge to invited users, within the limits we set. If we introduce
fees, we'll tell you in advance, and you can stop using the Service before they apply.</p>

<h2>9. Suspension and termination</h2>
<p>You can stop using the Service at any time and ask us to delete your account. We may suspend or end your access
if you break these terms, if your use puts the Service or others at risk, or if we stop offering the Service. We'll
give notice where reasonable. On termination we delete your data as our Privacy Policy describes.</p>

<h2>10. Disclaimer</h2>
<p>The Service is provided “as is” and “as available”, without warranties of any kind, express or implied,
including fitness for a particular purpose, merchantability and non-infringement, to the fullest extent the law
allows.</p>

<h2>11. Limitation of liability</h2>
<p>To the fullest extent the law allows, we are not liable for indirect, incidental, special, consequential or
punitive damages, or for lost profits, revenue, data or goodwill. Our total liability for any claim about the
Service is limited to the greater of the amount you paid us in the 12 months before the claim and EUR 100. Nothing
in these terms limits liability that can't be limited by law, such as for death or personal injury caused by
negligence, fraud, or gross negligence or wilful misconduct. Consumers keep any mandatory rights they have under
local law.</p>

<h2>12. Indemnity</h2>
<p>If you use the Service for business, you'll defend and indemnify us against third-party claims arising from your
content or your breach of these terms.</p>

<h2>13. Changes to these terms</h2>
<p>We may update these terms. We'll post the new version here and tell signed-in users about material changes at
least 14 days before they apply. If you keep using the Service after that, the new terms apply.</p>

<h2>14. Governing law</h2>
<p>These terms are governed by {LAW}. Consumers also keep the protection of the mandatory laws of the country where
they live.</p>

<h2>15. Contact</h2>
<p>{ENTITY}, {ADDRESS}. Email: {EMAIL}.</p>
"""

(ROOT / "privacy" / "index.html").write_text(page("Privacy Policy", "How Kernal and Outfitter collect, use and protect personal data.", PRIVACY))
(ROOT / "terms" / "index.html").write_text(page("Terms of Use", "The terms for using Kernal, Outfitter and kernal.one.", TERMS))
print("wrote privacy/ and terms/;", len(re.findall("mark class=\"todo\"", PRIVACY + TERMS)), "placeholders to fill")
