// Starter workspace created on first-run setup.
export const SUPERTAGS = [
  { name: 'cert', color: '#f59e0b', icon: '🎓', folder: 'Certifications',
    fields: [{ name: 'provider', type: 'text' }, { name: 'status', type: 'select', options: ['planning', 'studying', 'scheduled', 'passed', 'expired'] },
      { name: 'exam date', type: 'date' }, { name: 'score', type: 'number' }, { name: 'expires', type: 'date' }],
    template: 'provider:: \nstatus:: planning\nexam date:: \n\n## Exam objectives\n- [ ] \n\n## Resources\n- \n\n## Flashcards\nWhat does this cert cover? ?? \n' },
  { name: 'kb', color: '#0ea5e9', icon: '📘', folder: 'Work KB',
    fields: [{ name: 'system', type: 'text' }, { name: 'owner', type: 'text' }, { name: 'status', type: 'select', options: ['draft', 'verified', 'outdated'] }, { name: 'reviewed', type: 'date' }],
    template: 'system:: \nstatus:: draft\nreviewed:: \n\n## Problem\n\n## Resolution\n1. \n\n## Related\n- \n' },
  { name: 'service', color: '#10b981', icon: '🖥️', folder: 'Homelab',
    fields: [{ name: 'url', type: 'url' }, { name: 'host', type: 'text' }, { name: 'port', type: 'number' }, { name: 'stack', type: 'text' },
      { name: 'status', type: 'select', options: ['running', 'planned', 'retired'] }, { name: 'backup', type: 'text' }],
    template: 'url:: \nhost:: \nport:: \nstack:: \nstatus:: running\nbackup:: \n\n## Config\n```yaml\n\n```\n\n## Maintenance log\n- \n' },
  { name: 'runbook', color: '#ef4444', icon: '🧯', folder: 'Homelab',
    fields: [{ name: 'service', type: 'text' }, { name: 'last run', type: 'date' }],
    template: 'service:: \nlast run:: \n\n## When to use\n\n## Steps\n1. \n\n## Verify\n- [ ] \n' },
  { name: 'meeting', color: '#8b5cf6', icon: '🗓️', folder: 'Meetings',
    fields: [{ name: 'date', type: 'date' }, { name: 'attendees', type: 'text' }],
    template: 'date:: \nattendees:: \n\n## Notes\n- \n\n## Action items\n- [ ] \n' },
];

SUPERTAGS.push(
  { name: 'bill', color: '#e11d48', icon: '💳', folder: 'Household',
    fields: [{ name: 'amount', type: 'number' }, { name: 'due day', type: 'number' }, { name: 'autopay', type: 'select', options: ['yes', 'no'] },
      { name: 'account', type: 'text' }, { name: 'paid by', type: 'text' }, { name: 'status', type: 'select', options: ['active', 'paused', 'cancelled'] }],
    template: 'amount:: \ndue day:: \nautopay:: no\naccount:: \npaid by:: \nstatus:: active\n\n- [ ] Pay this bill @every month\n' },
  { name: 'chore', color: '#0d9488', icon: '🧹', folder: 'Household',
    fields: [{ name: 'assignee', type: 'text' }, { name: 'area', type: 'select', options: ['kitchen', 'bathroom', 'yard', 'garage', 'house', 'car'] }, { name: 'last done', type: 'date' }],
    template: 'assignee:: \narea:: house\nlast done:: \n\n- [ ] Do it @every week\n' },
);

export const NOTES = [
  { title: 'Welcome to Nexus', folder: '', pinned: 1, icon: '👋', content: `Your household second brain: notes, knowledge base, homelab docs and a shared calendar in one place.

## The essentials
- **Link notes** with \`[[Note Title]]\` – backlinks appear in the right panel, and the **Graph** view shows how ideas connect.
- **Tag** with \`#tag\`. Tags with fields become **supertags** (like Tana): \`#cert\`, \`#kb\`, \`#service\`, \`#runbook\`, \`#meeting\` – each one has its own database in the sidebar.
- **Properties**: write \`key:: value\` on its own line. Every supertag gets a Notion-style **database** (table + board) built from those properties.
- **Tasks**: \`- [ ] Renew TLS cert @2026-12-01\` – the date puts it on the calendar.
- **Flashcards**: \`Question ?? Answer\` or a \`Q:\` line followed by an \`A:\` line. Review them under *Review* with spaced repetition.
- **Slash menu**: type \`/\` at the start of a line. \`[[\` autocompletes note titles.

## Keyboard
| Keys | Action |
| --- | --- |
| Ctrl/⌘ K | Command palette & search |
| Ctrl/⌘ N | New note |
| Ctrl/⌘ D | Today's daily note |
| Ctrl/⌘ E | Toggle edit / preview |
| Ctrl/⌘ S | Save now |

## Shared calendar
Open **Calendar** to see both of your schedules side by side. Overlaps are flagged ⚠. Connect Google or Outlook under **Settings → Calendars**, or subscribe to the household feed from your phone.

> [!tip] Start here
> Open [[AZ-104 Study Plan]], [[Proxmox Host]] and [[Reset a user's MFA]] to see each workspace in action.
` },
  { title: 'AZ-104 Study Plan', folder: 'Certifications', icon: '🎓', content: `#cert
provider:: Microsoft
status:: studying
exam date:: ${new Date(Date.now() + 45 * 864e5).toISOString().slice(0, 10)}
score::

## Exam objectives
- [x] Manage Azure identities and governance (20–25%)
- [ ] Implement and manage storage (15–20%) @${new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)}
- [ ] Deploy and manage compute resources (20–25%)
- [ ] Implement and manage virtual networking (15–20%)
- [ ] Monitor and maintain Azure resources (10–15%)

## Flashcards
Max VNet peering hops for transitive routing without a gateway? ?? None – peering is non-transitive.
Which storage redundancy keeps 3 copies in one datacenter? ?? LRS (locally redundant storage)
Q: What RBAC role can manage everything except access?
A: Contributor

## Resources
- Microsoft Learn path
- Practice exams
`},
  { title: "Reset a user's MFA", folder: 'Work KB', icon: '📘', content: `#kb
system:: Entra ID
status:: verified
reviewed:: ${new Date().toISOString().slice(0, 10)}

## Problem
User has a new phone and can't complete MFA.

## Resolution
1. Verify identity per policy (callback to number on file).
2. Entra admin center → Users → *user* → Authentication methods → **Require re-register MFA**.
3. Revoke sessions.
4. Have the user sign in at \`https://aka.ms/mysecurityinfo\`.

## Related
- [[Proxmox Host]] runs the lab tenant's sync VM.
` },
  { title: 'Proxmox Host', folder: 'Homelab', icon: '🖥️', content: `#service
url:: https://192.168.1.10:8006
host:: pve01
port:: 8006
stack:: Proxmox VE
status:: running
backup:: Nightly vzdump to NAS

## Config
\`\`\`bash
# update
apt update && apt full-upgrade -y
\`\`\`

## Maintenance log
- [ ] Apply kernel updates and reboot @${new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)}
- [x] Replace failed SSD in ZFS mirror
` },
  { title: 'Groceries', folder: 'Household', icon: '🛒', pinned: 1, content: `Shared shopping list – tick things off in the store; add from your phone with *"add milk to the groceries list"* in the Claude app.

## Groceries
- [ ] Milk
- [ ] Eggs

## Household & pharmacy
- [ ] 

> [!tip] Bills and chores
> Use the **#bill** and **#chore** databases in the sidebar. Bills and chores get a repeating task (\`@every month\`), so they show up in Tasks and on the calendar and roll forward when you tick them.
` }
];
