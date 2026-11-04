// Adapted from whatsmyagentdoing, Copyright (c) 2026 cheoyu, MIT (public/licenses/agent-town-LICENSE.txt).
import { useId } from "react";

const palette = [
    { roof: '#738c70', dark: '#4f6c54', wall: '#f4e9c8', side: '#d9cb9f', trim: '#777c52' },
    { roof: '#b47c59', dark: '#8b5943', wall: '#f2e2c7', side: '#d8c2a3', trim: '#9f754e' },
    { roof: '#698994', dark: '#476874', wall: '#eee8d5', side: '#cecebb', trim: '#667f79' },
    { roof: '#a99a69', dark: '#837741', wall: '#f5ebcd', side: '#d8cb9e', trim: '#948357' },
  ];

export function AgentTownHouse({ index }: { index: number }) {
  const clipId = useId();
  const lightId = `${clipId}-light`;
  const c = palette[index % palette.length]!;
  return (
    <svg className="house-illustration" viewBox="0 0 320 250" aria-hidden="true">
      <defs><clipPath id={clipId}><path d="m83 157 26 8v26l-26-8Z"/></clipPath><radialGradient id={lightId}><stop stopColor="#ffd16c" stopOpacity=".9"/><stop offset=".5" stopColor="#ffd16c" stopOpacity=".4"/><stop offset="1" stopColor="#ffd16c" stopOpacity="0"/></radialGradient></defs>
      <ellipse cx="160" cy="224" rx="125" ry="16" fill="#bdcba9" opacity=".55"/>
      <g className="lot-garden">
        <path d="M5 195Q5 176 29 181L64 199Q66 221 41 222L15 212Z" fill="#b4c69b" stroke="#9db285"/>
        <path d="m11 202 3-7 3 8m8 7 2-7 3 7m10-13 3-6 2 7m-15-8 2-6 3 7m11 14 3-7 3 7" fill="none" stroke="#8fa778" strokeWidth="1.5"/>
        <ellipse cx="280" cy="205" rx="29" ry="13" fill="#b8cba0"/>
        <g className="shrubs" fill="#7e9c69" stroke="#6e8c5d" strokeWidth=".7"><ellipse cx="16" cy="193" rx="12" ry="10"/><ellipse cx="28" cy="189" rx="11" ry="12"/><ellipse cx="40" cy="196" rx="10" ry="9"/><ellipse cx="286" cy="197" rx="14" ry="11"/><ellipse cx="301" cy="199" rx="10" ry="9"/></g>
        <g fill="#a5bd8d"><ellipse cx="13" cy="190" rx="6" ry="4"/><ellipse cx="25" cy="184" rx="5" ry="6"/><ellipse cx="283" cy="192" rx="7" ry="4"/></g>
        <g className="flower-bed"><path d="m268 224 23 8 16-8-24-8Z" fill="#cbb08b" stroke="#ab8e69"/><path d="m272 223 19 6 11-5-19-6Z" fill="#8da276"/><path d="m276 222v-5m10 8v-8m11 7v-6" stroke="#6e8859" strokeWidth="2"/><g fill="#eee0ad"><circle cx="276" cy="217" r="3"/><circle cx="297" cy="218" r="3"/></g><circle cx="286" cy="217" r="3" fill="#d9b7a0"/></g>
      </g>
      <path d="M125 219 162 200 211 225 185 244Z" fill="#d8ccb0"/><path d="m145 220 20 10m-7-18 23 12" stroke="#c2b694" strokeWidth="2"/>
      <path d="M245 172v39m-7-4h16" stroke="#8b7953" strokeWidth="7"/><path d="m243 112-28 66h58z" fill="#88a276"/><path d="m247 98-22 57h44z" fill="#9ab382"/>
      <path d="M45 193v25m-4-4h10" stroke="#927b53" strokeWidth="6"/><circle cx="47" cy="179" r="21" fill="#a7b783"/><circle cx="37" cy="175" r="14" fill="#b4c391"/>
      <path d="M72 140 166 167 166 222 72 193Z" fill={c.wall}/><path d="M166 167 241 126 241 183 166 222Z" fill={c.side}/>
      <path d="M65 142 100 75 174 132 166 173Z" fill={c.roof}/><path d="M100 75 174 35 252 124 174 167 174 132Z" fill={c.dark}/>
      <path d="m70 137 95 29m-79-61 79 30m-66-50 67 26m-52-24 69 23m-62-36 100 109" fill="none" stroke="#fff" opacity=".12" strokeWidth="2"/>
      <path d="m100 75 74 57-8 35-94-28Z" fill={c.wall}/><path d="m66 140 34-65 74 57m-74-57 74-40 78 89-78 43" fill="none" stroke={c.trim} strokeWidth="6" strokeLinejoin="round"/>
      <g className="window-light" fill={`url(#${lightId})`}><ellipse cx="116" cy="123" rx="26" ry="27"/><ellipse cx="96" cy="175" rx="32" ry="31"/><ellipse cx="202" cy="165" rx="32" ry="36"/><ellipse cx="156" cy="190" rx="17" ry="21"/></g>
      <g className="upper-window"><path d="m103 104 27 8v28l-27-8Z" fill={c.trim}/><path className="window-glow" d="m108 110 18 6v18l-18-6Z"/><path d="m117 113v18m-9-12 18 6" stroke={c.trim} strokeWidth="2"/></g>
      <g className="front-window"><path d="m79 151 34 10v36l-34-10Z" fill={c.trim}/><path className="window-glow" d="m83 157 26 8v26l-26-8Z"/><path d="m96 161v26m-13-17 26 8" stroke={c.trim} strokeWidth="2.2"/><path className="light-highlight" d="m85 159 22 7" strokeWidth="1.5"/></g>
      <path d="m126 171 23 7v36l-23-7Z" fill="#8f7555"/><path className="window-glow" d="m130 176 15 5v15l-15-5Z"/><circle cx="143" cy="203" r="1.6" fill="#f2d08a"/>
      <g className="side-window"><path d="m184 153 35-19v42l-35 19Z" fill={c.trim}/><path className="window-glow" d="m189 157 25-14v30l-25 14Z"/><path d="m201 150v30m-12-8 25-14" stroke={c.trim} strokeWidth="2.2"/><path className="light-highlight" d="m191 158 21-12" strokeWidth="1.5"/></g>
      <g className="porch-lamp"><path d="m150 181 6-6 7 10Z" fill="#756548"/><path className="lamp-glass" d="m152 182 9 3v13l-9-3Z" stroke="#8a724a" strokeWidth="1.6"/><path className="light-highlight" d="m156 184v12" strokeWidth="2"/></g>
      <g className="window-clip" clipPath={`url(#${clipId})`}><g className="window-person" fill="#765c3f"><circle cx="96" cy="172" r="3.5"/><path d="m93 176 6 2 2 9-10-3Z"/></g></g>
      <g className="closed-curtains" fill="#445047" stroke="#2d3932" strokeWidth="1">
        <path d="m83 157 26 8v26l-26-8Z"/><path d="m89 159v26m7-24v26m7-24v26"/>
        <path d="m189 157 25-14v30l-25 14Z"/><path d="m195 154v30m7-34v30m6-33v30"/>
        <path d="m108 110 18 6v18l-18-6Z"/><path d="m114 112v18m6-16v18"/>
      </g>
      <g className="roof-pennant"><path d="M153 65V20" stroke="#6e715f" strokeWidth="2"/><g className="flag-cloth"><path d="M154 21q10-4 23 1l-5 6 5 6q-13-5-23-1Z" fill="#f5eed9" stroke="#8d8875" strokeWidth="1.3"/><path className="flag-mark" d="m158 26 5-1 6 2" fill="none" stroke="#766e58"/></g></g>
      <g className="house-chimney"><path d="m209 40 22-12v46l-22 12Z" fill="#997455"/><path d="m190 31 19 9v46l-19-10Z" fill="#b99b74"/><path d="m191 47 18 8m-18 8 18 8m5-19 16-9m-16 24 16-9" fill="none" stroke="#876c50" strokeWidth="1.7"/><path d="m185 29 23-12 29 12-25 15Z" fill="#dcc5a1" stroke="#aa906b" strokeWidth="1.2"/><path d="m195 29 14-7 18 7-15 8Z" fill="#746047"/></g>
      <g className="smoke"><g className="puff puff-one"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path className="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g><g className="puff puff-two"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path className="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g><g className="puff puff-three"><path d="M197 29c-10 0-14-10-7-15 0-9 13-12 19-5 9-5 20 0 18 8 8 7 2 14-7 13Z"/><path className="smoke-ridge" d="M194 19q5-6 11-2m6-4q8-2 11 5"/></g></g>
      <path d="m77 193 83 26m6 3 75-39" stroke="#b4aa84" strokeWidth="4"/>
      <path d="M86 191v9m10-6v9m-18-8 28 9" stroke="#c6b98e" strokeWidth="3"/>
      <ellipse cx="222" cy="204" rx="14" ry="5" fill="#9db580"/><ellipse cx="227" cy="199" rx="10" ry="7" fill="#99b27b"/>
      <circle cx="222" cy="195" r="2.2" fill="#f0d28d"/><circle cx="230" cy="198" r="2" fill="#e8b599"/>
      <path d="m54 215 4-6 3 7m194-1 4-7 3 6" stroke="#9aaf7a" strokeWidth="2" fill="none"/>
      <g className="sleeping-cat"><ellipse cx="176" cy="229" rx="19" ry="4" fill="#a8b292" opacity=".5"/><path d="M160 225q0-14 13-12 13 0 14 10-8 6-22 4" fill="#b29a79" stroke="#7e715e"/><path d="m176 217 2-7 6 4 5-3 1 9q-6 7-13 0Z" fill="#c4ae8e" stroke="#7e715e"/><path d="m178 219 3 1m3-1 3-1m-21 4q-13 4-10-5" stroke="#6e6455" fill="none" strokeLinecap="round"/><text className="rest-symbol" x="189" y="208" fill="#635f50" fontSize="17" fontFamily="Georgia,serif" fontWeight="bold">Zzz</text></g>
    </svg>
  );
}
