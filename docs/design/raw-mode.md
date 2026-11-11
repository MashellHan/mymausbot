# Raw interface mode

Raw is the default chat presentation. Simple and Advanced remain separate choices; changing the interface mode does not change conversations, bot permissions, or available capabilities.

## Visual contract

- Raw scopes its light palette to `data-interface-mode="raw"`: main `#fcfcfc`, sidebar `#f5f5f5`, assistant surface `#f0f0f0`, primary text `#1c1c1c`, secondary text `#666666`, white composer, and `#d7d7d7` control hairline. It uses the system sans stack rather than the other modes' type treatment.
- The desktop sidebar is 280px. Its primary bot tile is 95 × 93px; selected bot rows use an 11px radius. The transcript and composer share a 960px maximum track, with 16px inner clearance when space narrows. Assistant bubbles are at most 560px wide and align to the track's left; user bubbles align to its right. Message bubbles use a 18px radius and 15px text on a 22px line. The one-line composer is 44px high with a 23px radius and a visible border.
- The current bot's real avatar and name form the centered header pill. Share sits at the right. Raw removes persistent model, context, and Computer badges from that first-glance row; the bot panel, settings, and existing menus keep those functions reachable. The composer keeps its Add and voice actions. Tool and routine progress uses quiet 12px text with expandable details, while approvals, failures, and consequential warnings retain visible actions.
- Main bot user bubbles and voice emphasis are black. Other bots use their own identity color, not a global accent. Sidebar and header avatars remain tied to the actual bot.

## Preference and evidence

The General settings selector offers Raw, Simple, and Advanced. A missing or unrecognized stored choice resolves to Raw; an explicit Simple or Advanced choice is retained. The Simple-only build stays Simple. Mode choice is stored on this device and does not migrate bot data or grants.

At source `06b50a40374b271bdf794ff526eebe89f0eb4207`, isolated synthetic captures show Raw home and chat at 1440 × 900, chat at 1024 × 800 and 2560 × 1320, the mode selector, and a 390 × 844 web layout. Measured desktop sidebar width is 280px; composer widths are 960px at 1440/2560 and 712px at 1024. The 390px web capture reports 394px scroll width, so it does not establish zero horizontal overflow. These captures do not establish native macOS window behavior, live App appearance, microphone availability, or approval/error interactions. Visual acceptance belongs to the separate frozen-source review.
