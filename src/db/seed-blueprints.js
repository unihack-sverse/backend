// Demo data reproducing the website/demo prototype (07 §22). Demo content is never traction.
import { env } from '../config/env.js';
import { ensureSeedImage, seedAssetUrl } from './seed-assets.js';

export const demoPassword = 'correct-horse-9';
const TARGET_ITEMS_PER_GAME = 8;

export const studioBlueprints = [
  {
    key: 'voidrunner',
    owner: {
      pid: 'usr_demo',
      handle: 'kai',
      handleRaw: 'Kai',
      email: 'kai@example.com',
      roles: ['player', 'creator', 'moderator'],
      reputation: 94,
      playtimeMinutes: 41200,
      spendUnits: '184000000',
      clubScore: 61,
      accountAgeDays: 412,
      balanceUnits: '2450000000',
      skill: { tier: 'diamond_ii', firstClears: 3, tournamentBest: 'quarter_final' },
    },
    studio: {
      pid: 'std_kai',
      handle: 'kai.solo',
      displayName: 'Kai Solo',
      bio: 'Builds kinetic action games with portable item ownership.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '48120000000',
      netUnits: '43308000000',
      lockedUnits: '3120000000',
      availableUnits: '40188000000',
    },
    game: {
      pid: 'gam_voidrunner',
      slug: 'voidrunner',
      title: 'Voidrunner',
      blurb: 'A one-button roguelike about falling upward.',
      description:
        'Voidrunner is a fast solo-built roguelike where every run evolves your blade and leaves provenance behind.',
      genre: 'action_rpg',
      tokenizationLevel: 'L3',
      interopTier: 'T2',
      priceFromUnits: '85000000',
      stats: { playersLive: 1248, dau: 8210, mau: 45620, proofOfPlayScore: 8241.5, d1: 0.42, d7: 0.19, d30: 0.08 },
      club: { id: 'clb_voidrunner', memberCount: 4820, postRequiresOwnership: true },
      secondaryCount: 2,
      publishedAt: new Date('2026-06-01T00:00:00.000Z'),
      gradient: '#1b5e20,#ffd54f',
    },
    studioPrompt:
      'Create a square indie game studio emblem for "Kai Solo". Bright citrus and teal palette, bold geometric crest, clean vector illustration, no text, no watermark.',
    gamePrompt:
      'Create premium widescreen key art for an indie action roguelike named "Voidrunner": a lone runner ascending a collapsing obsidian tower, green energy blade, cinematic lighting, polished game cover, no text, no watermark.',
    items: [
      {
        pid: 'itd_vr_starter',
        sku: 'vr_starter',
        name: 'Starter Pack',
        description: 'Voidblade seed, 3 revives, 500 shards.',
        kind: 'bundle',
        priceUnits: '120000000',
        interopTier: 'T2',
        schemaId: 'sts/bundle/v1',
        supply: { type: 'limited', max: 5000, minted: 1284, remaining: 3716 },
        prompt:
          'Create square game item art for a premium starter pack: luminous void sword shard, revival capsule, green crystal shards, premium loot-box presentation, no text, no watermark.',
      },
      {
        pid: 'itd_vr_jacket',
        sku: 'vr_jacket',
        name: 'Ashmaw Jacket',
        description: 'Cross-game wearable jacket with ember trim.',
        kind: 'cosmetic',
        priceUnits: '85000000',
        interopTier: 'T1',
        schemaId: 'sts/cosmetic/wearable/v1',
        supply: { type: 'open', max: null, minted: 241, remaining: null },
        prompt:
          'Create square game item art for a stylish fantasy-tech jacket named "Ashmaw Jacket": ember seams, charcoal leather, premium wearable cosmetic render, isolated on a clean background, no text.',
      },
      {
        pid: 'itd_vr_blade',
        sku: 'vr_blade',
        name: 'Voidblade Emberfang',
        description: 'Living blade that records boss kills and flawless runs.',
        kind: 'living',
        priceUnits: '210000000',
        interopTier: 'T2',
        schemaId: 'sts/weapon/melee/v1',
        supply: { type: 'limited', max: 800, minted: 191, remaining: 609 },
        prompt:
          'Create square game item art for a living fantasy weapon called "Voidblade Emberfang": sleek obsidian blade, emerald plasma edge, collectible game render, dramatic but clean background, no text.',
      },
    ],
  },
  {
    key: 'grimloop',
    owner: {
      pid: 'usr_mira',
      handle: 'mira',
      handleRaw: 'Mira',
      email: 'mira@example.com',
      roles: ['player', 'creator'],
      reputation: 88,
      playtimeMinutes: 23800,
      spendUnits: '93000000',
      clubScore: 54,
      accountAgeDays: 320,
      balanceUnits: '1310000000',
      skill: { tier: 'platinum_i', firstClears: 2, tournamentBest: 'semi_final' },
    },
    studio: {
      pid: 'std_mira',
      handle: 'mira.forge',
      displayName: 'Mira Forge',
      bio: 'Builds tactical dungeon loops with collectible relics.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '32940000000',
      netUnits: '29646000000',
      lockedUnits: '2010000000',
      availableUnits: '27636000000',
    },
    game: {
      pid: 'gam_grimloop',
      slug: 'grimloop',
      title: 'Grimloop',
      blurb: 'A tactical dungeon loop where your relic remembers every escape.',
      description: 'Grimloop rewards clean routing, short retries, and wearable cosmetics that port between worlds.',
      genre: 'action_rpg',
      tokenizationLevel: 'L3',
      interopTier: 'T2',
      priceFromUnits: '70000000',
      stats: { playersLive: 840, dau: 4180, mau: 20880, proofOfPlayScore: 6120.1, d1: 0.39, d7: 0.22, d30: 0.1 },
      club: { id: 'clb_grimloop', memberCount: 2190, postRequiresOwnership: true },
      secondaryCount: 1,
      publishedAt: new Date('2026-06-12T00:00:00.000Z'),
      gradient: '#4a148c,#ffca28',
    },
    studioPrompt:
      'Create a square studio sigil for "Mira Forge": mysterious dungeon-cartography emblem, obsidian, brass and magenta palette, polished vector game brand, no text.',
    gamePrompt:
      'Create premium widescreen key art for a dark indie action roguelike named "Grimloop": looping dungeon corridors, glowing relic at the center, tactical fantasy mood, no text, no watermark.',
    items: [
      {
        pid: 'itd_gl_cloak',
        sku: 'gl_cloak',
        name: 'Ashen Cloak',
        description: 'High-collar cloak that renders in allied dark-fantasy titles.',
        kind: 'cosmetic',
        priceUnits: '78000000',
        interopTier: 'T1',
        schemaId: 'sts/cosmetic/wearable/v1',
        supply: { type: 'open', max: null, minted: 188, remaining: null },
        prompt:
          'Create square item art for an elegant dark fantasy cloak named "Ashen Cloak": layered charcoal fabric, ember lining, premium cosmetic render, no text.',
      },
      {
        pid: 'itd_gl_relic',
        sku: 'gl_relic',
        name: 'Scarbound Relic',
        description: 'Living relic that stores scars from mythic clears.',
        kind: 'living',
        priceUnits: '190000000',
        interopTier: 'T2',
        schemaId: 'sts/weapon/relic/v1',
        supply: { type: 'limited', max: 900, minted: 301, remaining: 599 },
        prompt:
          'Create square item art for a mystical relic named "Scarbound Relic": fractured stone core, violet rune scars, collectible game render, no text.',
      },
    ],
  },
  {
    key: 'hexfleet',
    owner: {
      pid: 'usr_nadia',
      handle: 'nadia',
      handleRaw: 'Nadia',
      email: 'nadia@example.com',
      roles: ['player', 'creator'],
      reputation: 83,
      playtimeMinutes: 18940,
      spendUnits: '102000000',
      clubScore: 49,
      accountAgeDays: 270,
      balanceUnits: '980000000',
      skill: { tier: 'gold_iv', firstClears: 1, tournamentBest: 'top_8' },
    },
    studio: {
      pid: 'std_nadia',
      handle: 'nadia.vector',
      displayName: 'Nadia Vector',
      bio: 'Makes fleet tactics with living ship parts and clear telemetry.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '28400000000',
      netUnits: '25560000000',
      lockedUnits: '1700000000',
      availableUnits: '23860000000',
    },
    game: {
      pid: 'gam_hexfleet',
      slug: 'hexfleet',
      title: 'Hexfleet',
      blurb: 'Command a modular armada in tight tactical battles.',
      description: 'Hexfleet turns ship parts into persistent collectibles without breaking the host game balance.',
      genre: 'strategy',
      tokenizationLevel: 'L3',
      interopTier: 'T2',
      priceFromUnits: '91000000',
      stats: { playersLive: 620, dau: 3310, mau: 14500, proofOfPlayScore: 5011.8, d1: 0.34, d7: 0.18, d30: 0.09 },
      club: { id: 'clb_hexfleet', memberCount: 1540, postRequiresOwnership: true },
      secondaryCount: 1,
      publishedAt: new Date('2026-05-24T00:00:00.000Z'),
      gradient: '#0d47a1,#80cbc4',
    },
    studioPrompt:
      'Create a square sci-fi indie studio emblem for "Nadia Vector": tactical hex-grid insignia, navy and mint palette, clean vector logo, no text.',
    gamePrompt:
      'Create premium widescreen key art for an indie tactical fleet strategy game named "Hexfleet": modular starships arranged on a glowing hex grid above a storm planet, no text.',
    items: [
      {
        pid: 'itd_hf_flag',
        sku: 'hf_flag',
        name: 'Commander Flag',
        description: 'Faction banner cosmetic displayed across allied T1 hosts.',
        kind: 'cosmetic',
        priceUnits: '64000000',
        interopTier: 'T1',
        schemaId: 'sts/cosmetic/banner/v1',
        supply: { type: 'open', max: null, minted: 127, remaining: null },
        prompt:
          'Create square item art for a tactical sci-fi cosmetic called "Commander Flag": crisp fleet pennant, teal insignia, premium collectible render, no text.',
      },
      {
        pid: 'itd_hf_hull',
        sku: 'hf_hull',
        name: 'Dreadnought Hull',
        description: 'Living capital-ship hull that records fleet wipes.',
        kind: 'living',
        priceUnits: '240000000',
        interopTier: 'T2',
        schemaId: 'sts/vehicle/capital/v1',
        supply: { type: 'limited', max: 640, minted: 204, remaining: 436 },
        prompt:
          'Create square item art for a collectible sci-fi capital ship hull named "Dreadnought Hull": angular armor plating, teal engine glow, premium game render, no text.',
      },
    ],
  },
  {
    key: 'petalpost',
    owner: {
      pid: 'usr_yuu',
      handle: 'yuu',
      handleRaw: 'Yuu',
      email: 'yuu@example.com',
      roles: ['player', 'creator'],
      reputation: 79,
      playtimeMinutes: 15400,
      spendUnits: '68000000',
      clubScore: 44,
      accountAgeDays: 198,
      balanceUnits: '770000000',
      skill: { tier: 'gold_i', firstClears: 0, tournamentBest: null },
    },
    studio: {
      pid: 'std_yuu',
      handle: 'yuu.post',
      displayName: 'Yuu Post',
      bio: 'Quiet delivery games with rich social cosmetics and item bundles.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '21900000000',
      netUnits: '19710000000',
      lockedUnits: '1210000000',
      availableUnits: '18500000000',
    },
    game: {
      pid: 'gam_petalpost',
      slug: 'petalpost',
      title: 'Petalpost',
      blurb: 'Deliver letters across a windblown city of gardens.',
      description: 'Petalpost is a cozy courier sim where cosmetics and bikes move cleanly across the Sverse wardrobe graph.',
      genre: 'cozy',
      tokenizationLevel: 'L2',
      interopTier: 'T1',
      priceFromUnits: '45000000',
      stats: { playersLive: 930, dau: 5620, mau: 30100, proofOfPlayScore: 4588.4, d1: 0.47, d7: 0.28, d30: 0.16 },
      club: { id: 'clb_petalpost', memberCount: 3180, postRequiresOwnership: true },
      secondaryCount: 0,
      publishedAt: new Date('2026-07-03T00:00:00.000Z'),
      gradient: '#f06292,#ffcc80',
    },
    studioPrompt:
      'Create a square cozy game studio emblem for "Yuu Post": floral courier seal, coral and cream palette, soft vector design, no text.',
    gamePrompt:
      'Create premium widescreen key art for a cozy delivery game named "Petalpost": bicycle courier weaving through suspended gardens and lantern streets at golden hour, no text.',
    items: [
      {
        pid: 'itd_pp_bike',
        sku: 'pp_bike',
        name: 'Brass Bicycle',
        description: 'Stylized courier bicycle cosmetic rendered in allied cozy titles.',
        kind: 'cosmetic',
        priceUnits: '52000000',
        interopTier: 'T1',
        schemaId: 'sts/cosmetic/vehicle/v1',
        supply: { type: 'open', max: null, minted: 356, remaining: null },
        prompt:
          'Create square item art for a charming courier bicycle named "Brass Bicycle": brass frame, flower satchel, cozy premium collectible render, no text.',
      },
      {
        pid: 'itd_pp_satchel',
        sku: 'pp_satchel',
        name: 'Courier Satchel',
        description: 'Bundle of route boosts, stamps, and a rare courier palette.',
        kind: 'bundle',
        priceUnits: '88000000',
        interopTier: 'T1',
        schemaId: 'sts/bundle/v1',
        supply: { type: 'limited', max: 2400, minted: 742, remaining: 1658 },
        prompt:
          'Create square item art for a cozy premium bundle named "Courier Satchel": leather satchel, wax seals, floral parcels, collectible game render, no text.',
      },
    ],
  },
  {
    key: 'lumen-leap',
    owner: {
      pid: 'usr_sora',
      handle: 'sora',
      handleRaw: 'Sora',
      email: 'sora@example.com',
      roles: ['player', 'creator'],
      reputation: 81,
      playtimeMinutes: 17020,
      spendUnits: '75000000',
      clubScore: 46,
      accountAgeDays: 232,
      balanceUnits: '820000000',
      skill: { tier: 'gold_ii', firstClears: 1, tournamentBest: 'top_16' },
    },
    studio: {
      pid: 'std_sora',
      handle: 'sora.light',
      displayName: 'Sora Light',
      bio: 'Makes precision platformers with clean cosmetics and readable motion.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '24100000000',
      netUnits: '21690000000',
      lockedUnits: '1310000000',
      availableUnits: '20380000000',
    },
    game: {
      pid: 'gam_lumen_leap',
      slug: 'lumen-leap',
      title: 'Lumen Leap',
      blurb: 'Dash between light rails in a fast precision platformer.',
      description: 'Lumen Leap turns movement cosmetics into the highest-converting T1 purchases in the network.',
      genre: 'platformer',
      tokenizationLevel: 'L2',
      interopTier: 'T1',
      priceFromUnits: '40000000',
      stats: { playersLive: 710, dau: 4510, mau: 22800, proofOfPlayScore: 4720.6, d1: 0.45, d7: 0.25, d30: 0.13 },
      club: { id: 'clb_lumen_leap', memberCount: 2870, postRequiresOwnership: true },
      secondaryCount: 0,
      publishedAt: new Date('2026-06-28T00:00:00.000Z'),
      gradient: '#00695c,#fff176',
    },
    studioPrompt:
      'Create a square bright indie studio emblem for "Sora Light": radiant platformer crest, aqua and yellow palette, polished vector badge, no text.',
    gamePrompt:
      'Create premium widescreen key art for a precision platformer named "Lumen Leap": runner leaping across glowing rails in a crystalline sky canyon, no text.',
    items: [
      {
        pid: 'itd_ll_trail',
        sku: 'll_trail',
        name: 'Aurora Trail',
        description: 'Movement trail cosmetic that renders across multiple T1 hosts.',
        kind: 'cosmetic',
        priceUnits: '61000000',
        interopTier: 'T1',
        schemaId: 'sts/cosmetic/trail/v1',
        supply: { type: 'open', max: null, minted: 268, remaining: null },
        prompt:
          'Create square item art for a movement cosmetic named "Aurora Trail": ribbon of glowing teal and gold light, premium collectible render, no text.',
      },
      {
        pid: 'itd_ll_prism',
        sku: 'll_prism',
        name: 'Prism Stepper',
        description: 'Consumable prism charge that unlocks advanced challenge routes.',
        kind: 'consumable',
        priceUnits: '34000000',
        interopTier: 'T0',
        schemaId: 'sts/consumable/charge/v1',
        supply: { type: 'open', max: null, minted: 890, remaining: null },
        prompt:
          'Create square item art for a consumable called "Prism Stepper": luminous crystal charge with clean sci-fi casing, premium game render, no text.',
      },
    ],
  },
  {
    key: 'shardport',
    owner: {
      pid: 'usr_orin',
      handle: 'orin',
      handleRaw: 'Orin',
      email: 'orin@example.com',
      roles: ['player', 'creator'],
      reputation: 77,
      playtimeMinutes: 14110,
      spendUnits: '59000000',
      clubScore: 39,
      accountAgeDays: 185,
      balanceUnits: '690000000',
      skill: { tier: 'silver_i', firstClears: 0, tournamentBest: null },
    },
    studio: {
      pid: 'std_orin',
      handle: 'orin.harbor',
      displayName: 'Orin Harbor',
      bio: 'Builds systemic economy sims and dense tactical sandboxes.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '19800000000',
      netUnits: '17820000000',
      lockedUnits: '1100000000',
      availableUnits: '16720000000',
    },
    studioPrompt:
      'Create a square studio emblem for "Orin Harbor": nautical commerce sigil, brass and cyan palette, clean indie strategy branding, no text.',
    games: [
      {
        pid: 'gam_shardport',
        slug: 'shardport',
        title: 'Shardport',
        blurb: 'Run a crystalline harbor where every trade route is contested.',
        description: 'Shardport is a compact port-management sim built around convoy routing, city mood, and player-owned merchant fleets.',
        genre: 'strategy',
        tokenizationLevel: 'L2',
        interopTier: 'T1',
        priceFromUnits: '58000000',
        stats: { playersLive: 540, dau: 2980, mau: 13200, proofOfPlayScore: 4018.4, d1: 0.36, d7: 0.21, d30: 0.11 },
        club: { id: 'clb_shardport', memberCount: 1180, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-08T00:00:00.000Z'),
        gradient: '#005662,#d5f4ff',
        prompt:
          'Create premium widescreen key art for an indie harbor strategy game named "Shardport": crystalline docks, cargo skiffs, glowing sea lanes at dusk, no text.',
      },
      {
        pid: 'gam_signal_cartel',
        slug: 'signal-cartel',
        title: 'Signal Cartel',
        blurb: 'Broker encrypted radio traffic across a cold-water archipelago.',
        description: 'Signal Cartel is a stealth-economy strategy game about transmission lanes, smuggling intel, and portable control-room cosmetics.',
        genre: 'strategy',
        tokenizationLevel: 'L3',
        interopTier: 'T2',
        priceFromUnits: '89000000',
        stats: { playersLive: 410, dau: 2140, mau: 9900, proofOfPlayScore: 3884.2, d1: 0.33, d7: 0.18, d30: 0.09 },
        club: { id: 'clb_signal_cartel', memberCount: 920, postRequiresOwnership: true },
        secondaryCount: 1,
        publishedAt: new Date('2026-07-18T00:00:00.000Z'),
        gradient: '#10263f,#6be0ff',
        prompt:
          'Create premium widescreen key art for an indie strategy game named "Signal Cartel": clandestine radio towers, stormy islands, neon signal paths over dark water, no text.',
      },
    ],
    items: [],
  },
  {
    key: 'mossrail',
    owner: {
      pid: 'usr_mae',
      handle: 'mae',
      handleRaw: 'Mae',
      email: 'mae@example.com',
      roles: ['player', 'creator'],
      reputation: 76,
      playtimeMinutes: 13220,
      spendUnits: '52000000',
      clubScore: 37,
      accountAgeDays: 171,
      balanceUnits: '640000000',
      skill: { tier: 'silver_iii', firstClears: 0, tournamentBest: null },
    },
    studio: {
      pid: 'std_mae',
      handle: 'mae.moss',
      displayName: 'Mae Moss',
      bio: 'Makes quiet route-planning games with tactile worlds and readable economies.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '17600000000',
      netUnits: '15840000000',
      lockedUnits: '980000000',
      availableUnits: '14860000000',
    },
    studioPrompt:
      'Create a square cozy-strategy studio emblem for "Mae Moss": ivy-wrapped rail insignia, moss green and warm cream palette, polished vector badge, no text.',
    games: [
      {
        pid: 'gam_mossrail',
        slug: 'mossrail',
        title: 'Mossrail',
        blurb: 'Reconnect sleepy hillside towns with a hand-built rail line.',
        description: 'Mossrail is a cozy logistics game about rebuilding stations, smoothing timetables, and carrying player cosmetics across calm worlds.',
        genre: 'cozy',
        tokenizationLevel: 'L2',
        interopTier: 'T1',
        priceFromUnits: '48000000',
        stats: { playersLive: 610, dau: 3620, mau: 16740, proofOfPlayScore: 4290.7, d1: 0.44, d7: 0.27, d30: 0.15 },
        club: { id: 'clb_mossrail', memberCount: 1490, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-11T00:00:00.000Z'),
        gradient: '#3e6b52,#dfe9b0',
        prompt:
          'Create premium widescreen key art for a cozy indie route-building game named "Mossrail": tiny train crossing terraced hills and overgrown stations at sunrise, no text.',
      },
    ],
    items: [],
  },
  {
    key: 'driftshock',
    owner: {
      pid: 'usr_tamsin',
      handle: 'tamsin',
      handleRaw: 'Tamsin',
      email: 'tamsin@example.com',
      roles: ['player', 'creator'],
      reputation: 82,
      playtimeMinutes: 18440,
      spendUnits: '87000000',
      clubScore: 47,
      accountAgeDays: 226,
      balanceUnits: '930000000',
      skill: { tier: 'gold_iii', firstClears: 1, tournamentBest: 'top_16' },
    },
    studio: {
      pid: 'std_tamsin',
      handle: 'tamsin.rift',
      displayName: 'Tamsin Rift',
      bio: 'Builds aggressive movement games with sharp combat loops.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '26600000000',
      netUnits: '23940000000',
      lockedUnits: '1420000000',
      availableUnits: '22520000000',
    },
    studioPrompt:
      'Create a square action-game studio emblem for "Tamsin Rift": fractured lightning crest, red and cobalt palette, premium vector mark, no text.',
    games: [
      {
        pid: 'gam_driftshock',
        slug: 'driftshock',
        title: 'Driftshock',
        blurb: 'Slide-cancel through collapsing arenas and turn momentum into damage.',
        description: 'Driftshock is a fast movement-combat game tuned around chase lines, combat resets, and high-value T2 item provenance.',
        genre: 'action_rpg',
        tokenizationLevel: 'L3',
        interopTier: 'T2',
        priceFromUnits: '93000000',
        stats: { playersLive: 770, dau: 4630, mau: 21110, proofOfPlayScore: 5440.3, d1: 0.41, d7: 0.2, d30: 0.1 },
        club: { id: 'clb_driftshock', memberCount: 1810, postRequiresOwnership: true },
        secondaryCount: 1,
        publishedAt: new Date('2026-06-20T00:00:00.000Z'),
        gradient: '#5a1f2a,#5cbcff',
        prompt:
          'Create premium widescreen key art for an indie action game named "Driftshock": armored runner powersliding through a collapsing neon arena, sparks and debris, no text.',
      },
      {
        pid: 'gam_null_saint',
        slug: 'null-saint',
        title: 'Null Saint',
        blurb: 'Break cursed processions with a stun-lance and perfect dodges.',
        description: 'Null Saint is a condensed boss-rush action game where readability, run history, and portable cosmetics drive retention.',
        genre: 'action_rpg',
        tokenizationLevel: 'L2',
        interopTier: 'T1',
        priceFromUnits: '62000000',
        stats: { playersLive: 460, dau: 2730, mau: 12040, proofOfPlayScore: 3662.9, d1: 0.38, d7: 0.2, d30: 0.1 },
        club: { id: 'clb_null_saint', memberCount: 960, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-02T00:00:00.000Z'),
        gradient: '#40214d,#f0d9ff',
        prompt:
          'Create premium widescreen key art for a stylized boss-rush game named "Null Saint": lone lancer facing a ghost procession in a violet cathedral street, no text.',
      },
    ],
    items: [],
  },
  {
    key: 'glass-circuit',
    owner: {
      pid: 'usr_ivo',
      handle: 'ivo',
      handleRaw: 'Ivo',
      email: 'ivo@example.com',
      roles: ['player', 'creator'],
      reputation: 74,
      playtimeMinutes: 12030,
      spendUnits: '47000000',
      clubScore: 33,
      accountAgeDays: 154,
      balanceUnits: '580000000',
      skill: { tier: 'silver_iv', firstClears: 0, tournamentBest: null },
    },
    studio: {
      pid: 'std_ivo',
      handle: 'ivo.circuit',
      displayName: 'Ivo Circuit',
      bio: 'Designs puzzle systems with exact feedback and premium clarity.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '14900000000',
      netUnits: '13410000000',
      lockedUnits: '860000000',
      availableUnits: '12550000000',
    },
    studioPrompt:
      'Create a square puzzle-game studio emblem for "Ivo Circuit": faceted glass maze icon, cyan and plum palette, precise vector badge, no text.',
    games: [
      {
        pid: 'gam_glass_circuit',
        slug: 'glass-circuit',
        title: 'Glass Circuit',
        blurb: 'Route light through fragile rooms that remember every wrong move.',
        description: 'Glass Circuit is a minimalist puzzle game about chaining mirrors, preserving perfect solves, and exporting elegant cosmetic motifs.',
        genre: 'puzzle',
        tokenizationLevel: 'L2',
        interopTier: 'T1',
        priceFromUnits: '36000000',
        stats: { playersLive: 390, dau: 2490, mau: 11420, proofOfPlayScore: 3424.6, d1: 0.46, d7: 0.29, d30: 0.16 },
        club: { id: 'clb_glass_circuit', memberCount: 870, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-16T00:00:00.000Z'),
        gradient: '#25455e,#d8b0ff',
        prompt:
          'Create premium widescreen key art for a puzzle game named "Glass Circuit": crystalline mirrors redirecting beams through dark geometric chambers, no text.',
      },
    ],
    items: [],
  },
  {
    key: 'starloom',
    owner: {
      pid: 'usr_hana',
      handle: 'hana',
      handleRaw: 'Hana',
      email: 'hana@example.com',
      roles: ['player', 'creator'],
      reputation: 80,
      playtimeMinutes: 16880,
      spendUnits: '71000000',
      clubScore: 43,
      accountAgeDays: 214,
      balanceUnits: '810000000',
      skill: { tier: 'gold_i', firstClears: 1, tournamentBest: 'top_32' },
    },
    studio: {
      pid: 'std_hana',
      handle: 'hana.echo',
      displayName: 'Hana Echo',
      bio: 'Builds bright arcade games with exact feel and collectible style.',
      oneHumanStudio: true,
      feeTier: 'standard',
      feeBps: 1000,
      grossUnits: '22100000000',
      netUnits: '19890000000',
      lockedUnits: '1260000000',
      availableUnits: '18630000000',
    },
    studioPrompt:
      'Create a square arcade studio emblem for "Hana Echo": starburst ribbon crest, coral and electric blue palette, playful premium vector mark, no text.',
    games: [
      {
        pid: 'gam_starloom',
        slug: 'starloom',
        title: 'Starloom',
        blurb: 'Swing between stitched constellations in a glittering sky workshop.',
        description: 'Starloom is a fast precision platformer about preserving flow lines, chaining movement cosmetics, and rewarding clean replays.',
        genre: 'platformer',
        tokenizationLevel: 'L2',
        interopTier: 'T1',
        priceFromUnits: '42000000',
        stats: { playersLive: 680, dau: 4210, mau: 19080, proofOfPlayScore: 4622.8, d1: 0.45, d7: 0.24, d30: 0.12 },
        club: { id: 'clb_starloom', memberCount: 1760, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-05T00:00:00.000Z'),
        gradient: '#1d4ed8,#ff8ab8',
        prompt:
          'Create premium widescreen key art for a bright indie platformer named "Starloom": agile runner swinging through stitched constellations and glowing thread bridges, no text.',
      },
      {
        pid: 'gam_afterglow_party',
        slug: 'afterglow-party',
        title: 'Afterglow Party',
        blurb: 'Micro-arcade rounds built for score chasing and loud cosmetics.',
        description: 'Afterglow Party is a tight arcade score-attack collection where social loops, replay clips, and T1 cosmetic carry-over drive conversion.',
        genre: 'arcade',
        tokenizationLevel: 'L1',
        interopTier: 'T1',
        priceFromUnits: '30000000',
        stats: { playersLive: 520, dau: 3380, mau: 15820, proofOfPlayScore: 3518.5, d1: 0.43, d7: 0.23, d30: 0.14 },
        club: { id: 'clb_afterglow_party', memberCount: 1210, postRequiresOwnership: true },
        secondaryCount: 0,
        publishedAt: new Date('2026-07-21T00:00:00.000Z'),
        gradient: '#7c3aed,#ff6b6b',
        prompt:
          'Create premium widescreen key art for an indie arcade collection named "Afterglow Party": vibrant neon minigame arena, confetti sparks, rhythmic crowd energy, no text.',
      },
    ],
    items: [],
  },
];


export async function generateSeedImages({ assetBaseUrl, forceImages }) {
  void assetBaseUrl;
  const specs = studioBlueprints.flatMap((entry) => [
    {
      relativePath: `studios/${entry.key}.png`,
      prompt: entry.studioPrompt,
      size: '1024x1024',
    },
    ...getBlueprintGames(entry).map((game) => ({
      relativePath: `games/${game.slug}-cover.png`,
      prompt: game.prompt,
      size: '1536x1024',
    })),
    ...getBlueprintItems(entry).map((item) => ({
      relativePath: `items/${item.assetKey ?? item.pid}.png`,
      prompt: item.prompt,
      size: '1024x1024',
    })),
  ]);

  for (const spec of specs) {
    await ensureSeedImage(spec, {
      apiKey: env.GEMINI_API_KEY,
      model: env.SEED_IMAGE_MODEL,
      force: forceImages,
    });
  }
}

export function resolveAssetBaseUrl() {
  return (env.PUBLIC_ASSET_BASE || `http://127.0.0.1:${env.PORT}`).replace(/\/$/, '');
}

export function studioAvatarUrl(entry, assetBaseUrl) {
  return seedAssetUrl(assetBaseUrl, `studios/${entry.key}.png`);
}

export function gameCoverUrl(entry, game, assetBaseUrl) {
  return seedAssetUrl(assetBaseUrl, `games/${game.slug}-cover.png`);
}

export function itemArtUrl(item, assetBaseUrl) {
  return seedAssetUrl(assetBaseUrl, `items/${item.assetKey ?? item.pid}.png`);
}


export function getBlueprintGames(entry) {
  if (entry.games?.length) return entry.games;
  return [{ ...entry.game, prompt: entry.gamePrompt }];
}

export function getBlueprintItems(entry) {
  const sourceItems = entry.items ?? [];
  const groupedItems = new Map(getBlueprintGames(entry).map((game) => [game.slug, []]));

  for (const item of sourceItems) {
    const game = getItemGame(entry, item);
    groupedItems.get(game.slug)?.push(item);
  }

  const synthesized = [];
  for (const game of getBlueprintGames(entry)) {
    const existing = groupedItems.get(game.slug) ?? [];
    synthesized.push(...existing);
    synthesized.push(...buildSupplementalItems(entry, game, existing, TARGET_ITEMS_PER_GAME - existing.length));
  }

  return synthesized;
}

export function getBlueprintGamesWithContext() {
  return studioBlueprints.flatMap((entry) => getBlueprintGames(entry).map((game) => ({ entry, game })));
}

export function getPrimaryGame(entry) {
  return getBlueprintGames(entry)[0];
}

export function getItemGame(entry, item) {
  if (!item.gameSlug) return getPrimaryGame(entry);
  return getBlueprintGames(entry).find((game) => game.slug === item.gameSlug) ?? getPrimaryGame(entry);
}

function buildSupplementalItems(entry, game, existingItems, needed) {
  if (needed <= 0) return [];

  const existingSkus = new Set(existingItems.map((item) => item.sku));
  const templateSpecs = [
    {
      suffix: 'sigil_wrap',
      name: 'Sigil Wrap',
      description: 'Signature wearable skin tuned for cross-game wardrobe rendering.',
      kind: 'cosmetic',
      schemaId: 'sts/cosmetic/wearable/v1',
      interopTier: 'T1',
      priceUnits: addUnits(game.priceFromUnits, 18000000),
      supply: openSupply(160 + existingItems.length * 18),
      prompt: `Create square premium game item art for a wearable called "Sigil Wrap" from ${game.title}: elegant ${genrePromptTag(game.genre)} apparel inspired by ${game.description}, isolated render, no text.`,
    },
    {
      suffix: 'vector_trail',
      name: 'Vector Trail',
      description: 'Movement trail cosmetic that keeps the game silhouette readable.',
      kind: 'cosmetic',
      schemaId: 'sts/cosmetic/trail/v1',
      interopTier: 'T1',
      priceUnits: addUnits(game.priceFromUnits, 12000000),
      supply: openSupply(220 + existingItems.length * 14),
      prompt: `Create square premium game item art for a movement cosmetic called "Vector Trail" from ${game.title}: motion streaks matching a ${genrePromptTag(game.genre)} aesthetic, clean background, no text.`,
    },
    {
      suffix: 'founder_cache',
      name: 'Founder Cache',
      description: 'Starter bundle of boosts, credits, and one rare cosmetic tint.',
      kind: 'bundle',
      schemaId: 'sts/bundle/v1',
      interopTier: game.interopTier === 'T2' ? 'T2' : 'T1',
      priceUnits: addUnits(game.priceFromUnits, 26000000),
      supply: limitedSupply(3200 + existingItems.length * 60, 900 + existingItems.length * 35),
      prompt: `Create square premium game item art for a launch bundle called "Founder Cache" from ${game.title}: curated loot crate with items themed around ${game.description}, polished collectible render, no text.`,
    },
    {
      suffix: 'pulse_charge',
      name: 'Pulse Charge',
      description: 'Consumable charge used to unlock high-difficulty routes and rerolls.',
      kind: 'consumable',
      schemaId: 'sts/consumable/charge/v1',
      interopTier: 'T0',
      priceUnits: addUnits(game.priceFromUnits, -12000000, 18000000),
      supply: openSupply(760 + existingItems.length * 28),
      prompt: `Create square premium game item art for a consumable called "Pulse Charge" from ${game.title}: compact energy charge reflecting ${genrePromptTag(game.genre)} gameplay, crisp isolated render, no text.`,
    },
    {
      suffix: 'deed_core',
      name: 'Deed Core',
      description: 'Living collectible that records verified clears, milestones, and showcase history.',
      kind: 'living',
      schemaId: schemaIdForGenre(game.genre),
      interopTier: game.interopTier === 'T0' ? 'T1' : game.interopTier,
      priceUnits: addUnits(game.priceFromUnits, 88000000),
      supply: limitedSupply(960 + existingItems.length * 25, 240 + existingItems.length * 10),
      prompt: `Create square premium game item art for a living collectible called "Deed Core" from ${game.title}: hero prop embodying ${game.description}, high-end collectible render, no text.`,
    },
    {
      suffix: 'club_banner',
      name: 'Club Banner',
      description: 'Social cosmetic flown in clubs, profiles, and compatible hosts.',
      kind: 'cosmetic',
      schemaId: 'sts/cosmetic/banner/v1',
      interopTier: 'T1',
      priceUnits: addUnits(game.priceFromUnits, 9000000),
      supply: openSupply(280 + existingItems.length * 12),
      prompt: `Create square premium game item art for a social cosmetic called "Club Banner" from ${game.title}: faction banner themed around ${game.description}, premium isolated render, no text.`,
    },
    {
      suffix: 'season_pass',
      name: 'Season Pass',
      description: 'Progression bundle that unlocks route skips, premium tasks, and one exclusive style set.',
      kind: 'bundle',
      schemaId: 'sts/bundle/v1',
      interopTier: game.interopTier === 'T2' ? 'T2' : 'T1',
      priceUnits: addUnits(game.priceFromUnits, 42000000),
      supply: limitedSupply(2400 + existingItems.length * 50, 640 + existingItems.length * 30),
      prompt: `Create square premium game item art for a progression bundle called "Season Pass" from ${game.title}: layered rewards card, premium game UI object, no text.`,
    },
    {
      suffix: 'echo_token',
      name: 'Echo Token',
      description: 'Consumable telemetry token used for retries, scouting, or challenge remixes.',
      kind: 'consumable',
      schemaId: 'sts/consumable/charge/v1',
      interopTier: 'T0',
      priceUnits: addUnits(game.priceFromUnits, -18000000, 12000000),
      supply: openSupply(980 + existingItems.length * 18),
      prompt: `Create square premium game item art for a consumable called "Echo Token" from ${game.title}: tokenized utility item inspired by ${genrePromptTag(game.genre)} play, isolated render, no text.`,
    },
  ];

  const generated = [];
  for (const spec of templateSpecs) {
    if (generated.length >= needed) break;
    const slugBase = compactSlug(game.slug);
    const sku = `${slugBase}_${spec.suffix}`;
    if (existingSkus.has(sku)) continue;
    generated.push({
      pid: `itd_${slugBase}_${spec.suffix}`,
      assetKey: sharedItemAssetKey(game, spec.suffix),
      gameSlug: game.slug,
      sku,
      name: `${game.title} ${spec.name}`,
      description: spec.description,
      kind: spec.kind,
      priceUnits: spec.priceUnits,
      interopTier: spec.interopTier,
      schemaId: spec.schemaId,
      supply: spec.supply,
      prompt: spec.prompt,
    });
  }

  return generated;
}

function compactSlug(slug) {
  return slug.replace(/-/g, '_');
}

function compactGenre(genre) {
  return String(genre).replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

function sharedItemAssetKey(game, suffix) {
  return `${compactGenre(game.genre)}_${suffix}`;
}

function openSupply(minted) {
  return { type: 'open', max: null, minted, remaining: null };
}

function limitedSupply(max, minted) {
  return { type: 'limited', max, minted, remaining: Math.max(max - minted, 0) };
}

function addUnits(priceUnits, delta, floor = 24000000) {
  return String(Math.max(Number(priceUnits) + delta, floor));
}

function schemaIdForGenre(genre) {
  if (genre === 'strategy') return 'sts/vehicle/capital/v1';
  if (genre === 'platformer') return 'sts/cosmetic/trail/v1';
  if (genre === 'puzzle') return 'sts/weapon/relic/v1';
  return 'sts/weapon/melee/v1';
}

function genrePromptTag(genre) {
  const tags = {
    action_rpg: 'kinetic action-fantasy',
    strategy: 'tactical sci-fi strategy',
    cozy: 'cozy handcrafted',
    platformer: 'bright precision-platformer',
    puzzle: 'clean cerebral puzzle',
    arcade: 'high-energy arcade',
  };

  return tags[genre] ?? 'stylized premium';
}





