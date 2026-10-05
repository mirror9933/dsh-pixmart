/**
 * 内置提示词模块表（纯数据）。
 *
 * 所有片段文本均为**本仓库原创**，针对电商产品摄影场景逐条撰写；
 * 组织方式参考了 pixmart-ai（MIT）的「模块 → 片段（fragments）」思路，
 * 但不含其任何代码或文本。
 *
 * 片段一律使用英文 —— 目标模型（Gemini / gpt-image 系）对英文指令的遵循度更稳，
 * 而 `label` 保持中文供界面展示。片段中出现 `{name}` 形式的占位符时，
 * 必须在同模块的 `variables` 中声明，由 `buildPrompt()` 负责替换。
 */

import type { ModuleDef } from './types.js'

export const MODULES = [
  // ─────────────────────────── main：主图 ───────────────────────────
  {
    id: 'main.white-bg',
    group: 'main',
    label: '白底首图',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Show the product alone and complete, centered, occupying roughly 75% of the frame height, photographed straight-on at eye level with a very slight five-degree downward tilt. Preserve the exact silhouette, colors, material sheen and every printed packaging text of the reference image; never rewrite, translate or invent label copy.',
      scene:
        'Pure seamless white background, uniform 255 white with no gradient banding, no floor line, no visible horizon, no surface texture and no props or decorative elements of any kind.',
      lighting:
        'Large softbox front-left at 45 degrees plus a white fill card on the right for broad even illumination. Contact shadow removed entirely, no visible studio equipment reflected on glossy surfaces, no hot spots on dark or metallic areas.',
      composition:
        'Shot with a 100mm macro-feel lens at f/11 for edge-to-edge sharpness; product centered with equal margins on all four sides, generous headroom and footroom so the subject never touches the frame edge.',
      finish:
        'Retail-catalog clean rendering, true-to-life color, neutral white balance, no HDR halos, no vignette, crisply defined product edges with natural micro-texture preserved.',
    },
    negativeHints:
      'No drop shadow, no floor reflection, no gradient background, no props, no watermark, no extra text or badges, no duplicate products, no cropped edges, no color cast.',
  },
  {
    id: 'main.scene',
    group: 'main',
    label: '场景主图',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Place the product as the single hero object at a natural three-quarter angle, slightly larger than life so shape, finish and packaging read instantly. Keep proportions, colors and existing packaging text identical to the reference image, and never add accessories that are absent from the reference.',
      scene:
        'A styled but uncluttered lifestyle setting that fits the product category — {background} — with background elements deliberately defocused and kept low in contrast directly behind the product.',
      lighting:
        'Soft directional daylight from a large window on the left, gentle wrap-around fill from a bounce board on the right, warm-neutral color temperature, controlled specular highlights so glossy and matte surfaces both keep detail.',
      composition:
        '35mm-equivalent perspective at an f/2.8 look, product placed on the left third with clean negative space on the right for later text; low horizon, foreground props suggest depth without covering the product.',
      finish:
        'Editorial commercial photography, gentle contrast curve, natural color saturation, fine texture without digital-art smoothing, believable depth falloff.',
    },
    negativeHints:
      'No cluttered background, no competing bright objects, no text overlays, no hands covering the product, no altered packaging text, no invented accessories, no harsh color cast.',
    variables: ['background'],
  },
  {
    id: 'main.selling-point',
    group: 'main',
    label: '卖点图',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Feature the product at a confident three-quarter hero angle, fully visible and unobstructed, with identity, color and printed packaging text preserved exactly from the reference. Express one key benefit through physical staging of the product itself rather than by inventing parts or features.',
      scene:
        'Clean gradient studio backdrop in a tone sampled from the product palette, plus one or two minimal supporting props that hint at the benefit without hiding the item or introducing objects absent from the reference.',
      lighting:
        'Softbox key above and slightly behind the product for a crisp top rim highlight, plus a broad frontal fill. Sculpted edge highlights separate the product from the background; no blown-out hotspots on labels or metal.',
      composition:
        '85mm product lens at f/8, product anchored on the right two thirds and tilted toward the viewer, leaving a clean vertical band of empty background on the left as reserved space for a short claim.',
      finish:
        'High-end e-commerce retouching: crisp micro-contrast, clean edges, accurate color, subtle background gradient, no halos and no over-sharpening.',
    },
    negativeHints:
      'No invented features, no extra components, no long paragraphs of text, no busy patterns behind the product, no distorted proportions, no rewritten label copy.',
  },
  {
    id: 'main.detail',
    group: 'main',
    label: '细节特写',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Fill the frame with one defining detail of the product — texture, stitching, button, nozzle, fabric weave or surface finish — enlarged so its structure is clearly readable, while keeping the material color and any printed text identical to the reference image.',
      scene:
        'Minimal neutral studio background softly out of focus, nothing else in frame to compete with the detail; keep a thin sliver of the product body visible so the close-up still reads as part of the whole.',
      lighting:
        'Raking side light from a narrow strip softbox at a low angle to reveal surface relief, with a large scrim opposite to lift shadow detail; small controlled speculars communicate material quality without glare.',
      composition:
        'Macro-style 100mm framing at f/8, shallow but not extreme depth of field, detail placed diagonally across the frame with the critical texture at the visual center.',
      finish:
        'Tack-sharp material rendering, faithful hue, visible fibers or grain, no plastic smoothing, no artificial glow, no over-clarity artifacts.',
    },
    negativeHints:
      'No uniform blur across the whole frame, no invented surface texture, no added logos or text, no dust or scratches, no color shift, no unreadable crop, no duplicate objects.',
  },
  {
    id: 'main.size-spec',
    group: 'main',
    label: '尺寸参数',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Present the product upright and undistorted at a frontal or very slight three-quarter view so all dimensions can be judged accurately. Keep shape, color and packaging text exactly as in the reference and never restretch or thin out the proportions.',
      scene:
        'Flat neutral light-grey studio background with a faint ground plane for scale, plus unobtrusive measurement lines and arrow markers drawn outside the product silhouette at consistent stroke weight.',
      lighting:
        'Even, nearly shadowless frontal illumination from two large softboxes at 45 degrees left and right with matched power; minimal speculars so dimension lines and captions stay perfectly legible.',
      composition:
        'Telecentric-style straight-on framing at f/11, product centered with wide even margins, measurement annotations aligned parallel to the product edges with consistently weighted typography.',
      finish:
        'Technical yet commercial rendering, flat accurate color, crisp annotation lines, no perspective distortion, no vignette, no decorative effects.',
    },
    negativeHints:
      'No perspective distortion, no incorrect or invented numbers, no cluttered labels, no obscured product edges, no decorative props, no altered packaging text.',
  },

  // ─────────────────────────── detail：详情图 ───────────────────────────
  {
    id: 'detail.hero',
    group: 'detail',
    label: '首屏主视觉',
    defaultSize: '16:9',
    fragments: {
      subject:
        'Stage the product as the unquestioned hero on a wide canvas, positioned off-center at a heroic three-quarter angle, rendered large and richly detailed. Preserve shape, color and all printed packaging text from the reference and add nothing that is not present there.',
      scene:
        'Cinematic wide environment suited to the category — an expansive gradient wall, a sunlit room, a sweeping natural landscape — with generous atmospheric depth behind the product and no distracting mid-ground clutter.',
      lighting:
        'Motivated cinematic key light from behind-left creating a bright rim, soft frontal fill holding detail in the shadows, gentle falloff toward the frame edges, warm highlights balanced against cooler shadow tones.',
      composition:
        '24mm-equivalent wide lens at an f/4 look, product on the left third with a large empty sky or wall area on the right for a headline; strong horizontal leading lines and a low camera height.',
      finish:
        'Premium campaign-grade retouching, rich but believable color grading, smooth tonal transitions, no crushed blacks, no artificial lens flares.',
    },
    negativeHints:
      'No crowded composition, no distorted product, no text baked into the image, no extra props stacked on the product, no muddy shadows, no invented accessories.',
  },
  {
    id: 'detail.scene',
    group: 'detail',
    label: '使用场景',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Show the product in active real-world use, held or operated naturally by hands, or worn on a person when relevant, with the product itself fully identifiable and its colors and printed text unchanged from the reference image.',
      scene:
        'Believable everyday environment matched to the target user — modern kitchen, tidy desk, city street, outdoor trail — with layered depth and secondary objects softly defocused, nothing that contradicts how the product is really used.',
      lighting:
        'Natural ambient light from a window or open sky, soft and slightly directional, with warm bounce from nearby surfaces keeping the product surface readable and free of color contamination from the surroundings.',
      composition:
        '50mm-equivalent human-eye framing at f/2.8, vertical 3:4 crop, product in the lower-center of the frame with clean upper space, hands entering from the frame edge rather than blocking the item.',
      finish:
        'Documentary-commercial hybrid look, natural skin and material tones, light filmic grade, clean but not sterile, no heavy filter effects.',
    },
    negativeHints:
      'No impossible use of the product, no cluttered background, no unreadable product, no distorted hands, no added text, no product alteration, no foreign brand logos.',
  },
  {
    id: 'detail.ambience',
    group: 'detail',
    label: '氛围图',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Treat the product as a quiet presence rather than a catalog subject: partially softened by depth of field or light haze but still clearly recognizable, with color, form and any visible packaging text unchanged from the reference image.',
      scene:
        'Mood-driven environment built from texture and light — linen drapes, stone surface, drifting steam, morning mist, dried botanicals — chosen to match the intended mood, with the product resting naturally inside the composition.',
      lighting:
        'Low-contrast directional light such as late-afternoon sun through a sheer curtain, visible soft light falloff, deep but clean shadows, warm-cool separation that builds an emotional atmosphere without hiding the product.',
      composition:
        'Vertical 3:4 frame with a 50mm-equivalent lens, product on the lower third, large areas of soft tonality above, blurred foreground elements framing the subject and guiding the eye inward.',
      finish:
        'Fine-art lifestyle rendering with subtle grain, muted but rich palette, gentle highlight roll-off, no heavy vignette, no artificial bokeh shapes.',
    },
    negativeHints:
      'No product obscured beyond recognition, no underexposed frame, no random unrelated objects, no text overlays, no color cast, no props absent from the reference.',
  },
  {
    id: 'detail.selling-point',
    group: 'detail',
    label: '核心卖点',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Show the product clearly at a three-quarter angle as the evidence for one claim, unobstructed and well lit, identical in shape, color and packaging text to the reference; isolate the specific feature through framing and light rather than by inventing parts.',
      scene:
        'Stacked clean studio background in two complementary tones with a subtle diagonal split, plus one minimal prop that supports the claim; everything behind the product stays soft and subordinate.',
      lighting:
        'Precise studio lighting: soft key from the front-left, a narrow accent light defining the highlighted feature, controlled reflections, no cross-shadows falling across the product face.',
      composition:
        'Vertical 3:4 composition with an 85mm-equivalent lens at f/8, product in the lower two thirds, a clean band of background above reserved for a short benefit line, clear vertical rhythm.',
      finish:
        'Crisp commercial retouch, vibrant but accurate color, strong edge definition, even tonal background, smooth gradients without banding.',
    },
    negativeHints:
      'No long text blocks, no claims rendered as baked words, no busy backgrounds, no invented features, no obscured product, no altered label copy.',
  },
  {
    id: 'detail.detail',
    group: 'detail',
    label: '细节特写',
    defaultSize: '3:4',
    requiresReference: true,
    fragments: {
      subject:
        'Using the supplied reference image as the only source of truth, magnify one authentic detail of exactly this product — stitch line, seam, coating, weave, joint or printed mark — reproducing its material, color and any visible text without reinterpretation and without adding parts that do not exist.',
      scene:
        'Neutral seamless studio background in a tone sampled from the product, entirely out of focus, with no props and no second object, so the enlarged detail holds the entire frame.',
      lighting:
        'Grazing strip light across the surface at a low angle to expose relief and micro-texture, plus a broad diffusion panel lifting shadow detail; keep speculars small and shaped like the real material.',
      composition:
        'Macro 100mm equivalent at f/8 with carefully controlled depth of field so the critical detail band is razor sharp, diagonal tension across the vertical 3:4 frame, detail centered slightly above middle.',
      finish:
        'True-to-material macro rendering, faithful hue, visible fibers and grain, no smoothing effects, no fake bloom, no over-sharpened halos.',
    },
    negativeHints:
      'No invented textures or patterns, no added logos or text, no dust, scratches or fingerprints, no color shift versus the reference, no full-frame blur, no second product.',
  },
  {
    id: 'detail.comparison',
    group: 'detail',
    label: '效果对比',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Present before-and-after states of the same product or its result: the product identical in shape, color and printed text to the reference in the after state, with only the condition or finish legitimately differing in the before state.',
      scene:
        'A split studio setting with a subtle dividing line, or a clean side-by-side arrangement on the same neutral surface, so the two states are compared fairly under otherwise equal conditions.',
      lighting:
        'Identical lighting for both halves — matched soft key and fill, consistent exposure and white balance — so any visible difference comes only from the product state and never from the lighting setup.',
      composition:
        'Vertical 3:4 frame divided into two balanced halves, 50mm-equivalent lens at f/8, product rendered at similar scale in both halves, empty caption space directly beneath each half.',
      finish:
        'Honest comparison rendering: clean and evenly graded, no contrast cheating, no selective brightening of the after half, natural color throughout.',
    },
    negativeHints:
      'No unfair lighting difference between halves, no exaggerated damage, no fake results, no extra text or numbers, no different products on each side, no manipulated label copy.',
  },
  {
    id: 'detail.craft',
    group: 'detail',
    label: '工艺材质',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Reveal how the product is made or what it is made of — material cross-section, weave, grain, welded joint, molded edge, brushed metal or painted finish — while reproducing exactly the material and printed text seen in the reference image.',
      scene:
        'Industrial-clean studio set: neutral seamless paper or a raw stone and metal surface echoing the material story, with the product resting beside a subtle process element such as raw material swatches or offcut pieces.',
      lighting:
        'Cross or raking light from a narrow softbox to sculpt edges and reveal texture, secondary bounce opening shadow detail, deliberate highlight placement along machined or woven lines.',
      composition:
        'Vertical 3:4 composition, 85mm equivalent at f/8, medium-close framing with the product at a slight angle, textured foreground leading into the material detail at the visual center.',
      finish:
        'Material-accurate rendering with strong micro-contrast and true color: metal reads metallic, fabric shows weave, wood shows grain, nothing looks plastic or painted on.',
    },
    negativeHints:
      'No invented manufacturing marks, no fake material texture, no added text or stamps, no oily residue or dust, no glowing edges, no color-shifted metal.',
  },
  {
    id: 'detail.series',
    group: 'detail',
    label: '系列展示',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Arrange several variants or sizes of the product family together, each keeping the exact shape, color scheme and printed packaging text of the reference, with consistent proportions across the line and no invented member added to the group.',
      scene:
        'One continuous clean studio environment with a smooth tonal backdrop and a shared surface, so the set reads as a single coherent family rather than separate shots composited together.',
      lighting:
        'A single unified rig for the whole group: broad soft key from the front-left, even fill, identical shadow direction and intensity across every item so no unit looks pasted in.',
      composition:
        'Vertical 3:4 frame with a 50mm-equivalent lens at f/8, products lined up along a gentle diagonal with the lead item largest in front, uniform spacing and every item fully inside the frame.',
      finish:
        'Consistent color and exposure across the entire series, crisp edges, clean separation between products, no per-item grading differences.',
    },
    negativeHints:
      'No mismatched lighting between items, no inconsistent scale, no duplicated items, no unknown extra variants, no overlapping that hides labels, no altered packaging text.',
  },
  {
    id: 'detail.size-spec',
    group: 'detail',
    label: '尺寸参数',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Show the product standing true and undistorted so every dimension is verifiable, keeping shape, color and packaging text identical to the reference, and displaying measurement callouts with fine arrow lines and restrained caption text.',
      scene:
        'Flat neutral background with a subtle floor-to-wall transition; a faint grid or ruler element may sit behind the product at low contrast to reinforce the sense of measurable scale.',
      lighting:
        'Matched twin softboxes at 45 degrees left and right with equal power for shadowless even coverage, a faint contact shadow for grounding, and no speculars crossing the annotation lines.',
      composition:
        'Vertical 3:4 technical framing with an 85mm equivalent at f/11, product centered, dimension lines parallel to the product edges, tidy alignment and consistent caption sizes.',
      finish:
        'Clean technical-commercial look, flat accurate color, high legibility for lines and captions, no perspective warp, no decorative effects.',
    },
    negativeHints:
      'No incorrect or invented measurements, no perspective distortion, no cluttered labels, no cropped product edges, no decorative props, no rewritten packaging text.',
  },
  {
    id: 'detail.accessories',
    group: 'detail',
    label: '配件赠品',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Lay out the product together with the accessories and gifts that genuinely ship with it, matching the reference exactly; never add an item that is not in the reference and preserve every printed label on packaging and parts.',
      scene:
        'Flat-lay arrangement on a clean matte surface matching the brand tone, with a subtle two-tone paper backdrop; each element clearly separated, fully visible and free of overlapping shadows.',
      lighting:
        'Large overhead softbox for even top-down illumination, low-angle fill preventing harsh shadows between items, controlled reflections on cables, metal and plastic parts.',
      composition:
        'True overhead flat lay in a vertical 3:4 frame, 50mm-equivalent lens at f/9, product as the largest anchor item with accessories grouped in tidy rows around it and even gaps between elements.',
      finish:
        'Neat knolling aesthetic, crisp edges, true color, subtle material highlights, clean white balance across plastic, metal and fabric.',
    },
    negativeHints:
      'No invented accessories, no duplicated items, no tangled cables, no overlapping that hides parts, no text overlays, no missing items, no altered packaging text.',
  },
  {
    id: 'detail.usage',
    group: 'detail',
    label: '使用建议',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Depict the product being used correctly and safely in a step or recommendation context, with the product itself fully accurate to the reference in shape, color and printed text, and with no implication of a use it cannot perform.',
      scene:
        'Practical everyday environment relevant to the recommendation — bathroom counter, workshop bench, kitchen surface — with only the items needed for that step present and clearly secondary to the product.',
      lighting:
        'Bright clean ambient light from above and the side, low-contrast and friendly, with enough fill to keep the scene legible and the product surface free of distracting glare.',
      composition:
        'Vertical 3:4 composition at a 50mm-equivalent focal length and f/5.6, product in the lower half, gentle instructional framing with clear open space in the upper area for a short guidance line.',
      finish:
        'Friendly guide-style commercial photography: natural color, soft contrast, clean and approachable, no dramatic grading, no heavy vignette.',
    },
    negativeHints:
      'No unsafe or wrong usage, no invented step text, no cluttered counter, no obscured product, no extra appliances, no altered packaging text.',
  },
  {
    id: 'detail.brand-story',
    group: 'detail',
    label: '品牌故事',
    defaultSize: '16:9',
    fragments: {
      subject:
        'Feature the product as the tangible centerpiece of the {brand} origin story, presented in a dignified three-quarter view with its authentic shape, color and printed packaging text preserved exactly from the reference; the object should feel like a heritage artifact rather than a catalog item.',
      scene:
        'Atmospheric narrative environment expressing the origin and values of the brand — workshop, atelier, shelves of raw material, a quiet landscape — richly textured but softly defocused behind the product, with clear empty space reserved for {slogan} typography later.',
      lighting:
        'Warm directional light motivated by a window or low sun, deep controlled shadows, a gentle golden rim along the product edge, and cool ambient fill on the shadow side for cinematic depth.',
      composition:
        'Wide 16:9 cinematic frame with a 35mm-equivalent lens at f/2.8, product on the right third at medium scale, expansive atmospheric space on the left for a headline and logo lockup.',
      finish:
        'Premium brand-film look: rich tonal range, subtle warm grade, natural texture, soft highlight roll-off, no digital HDR artifacts.',
    },
    negativeHints:
      'No fabricated historical claims as text, no modern clutter, no distorted product, no heavy vignette, no foreign logos, no altered packaging text.',
    variables: ['brand', 'slogan'],
  },
  {
    id: 'detail.after-sales',
    group: 'detail',
    label: '售后保障',
    defaultSize: '16:9',
    fragments: {
      subject:
        'Present the product confidently as a dependable purchase, shown clean, complete and slightly angled so build quality is evident; keep shape, color and printed packaging text exactly as in the reference and never add parts or certificates that do not exist.',
      scene:
        'Reassuring clean studio environment with a calm solid or softly graduated backdrop in brand-appropriate tones; a discreet shield, checkmark or service icon as a flat graphic shape may sit in the background corner.',
      lighting:
        'Even, trustworthy lighting from two large softboxes with a gentle top accent, no drama and no hard shadows, reflections minimized so the product reads as consistent and reliable.',
      composition:
        'Wide 16:9 frame with a 50mm-equivalent lens at f/8, product centered-right at a comfortable medium size, generous clean space on the left for a short guarantee statement.',
      finish:
        'Clean corporate commercial finish: accurate color, smooth gradients, crisp edges, calm contrast, no gimmicks.',
    },
    negativeHints:
      'No invented guarantees or numbers rendered as text, no cluttered props, no dark moody lighting, no distorted product, no added logos, no altered packaging text.',
  },
  {
    id: 'detail.multi-angle',
    group: 'detail',
    label: '多角度',
    defaultSize: '3:4',
    requiresReference: true,
    fragments: {
      subject:
        'From the provided reference image, render the exact same product from several complementary viewpoints — front, three-quarter, side, back and top as applicable — keeping geometry, color, proportions and every printed packaging text perfectly consistent across all views, with no invented details.',
      scene:
        'One identical neutral studio background and surface for every angle so the views clearly belong to the same shoot, with consistent scale and no environment change between panels.',
      lighting:
        'A single fixed lighting rig used for all angles — broad soft key front-left, fill on the right, subtle top rim — preserving the same shadow direction, intensity and color temperature in each view.',
      composition:
        'Vertical 3:4 layout with the multiple product views arranged in a tidy grid or row, 85mm-equivalent lens at f/9, matched scale and even spacing, each view fully inside its own cell without cropping.',
      finish:
        'Uniform grading across all angles, identical white balance and exposure, crisp clean edges, no per-panel color drift or inconsistency.',
    },
    negativeHints:
      'No geometry changes between views, no newly revealed features, no missing sides, no inconsistent lighting or scale, no text overlays, no altered packaging text.',
  },

  // ─────────────────────────── ad：广告图 ───────────────────────────
  {
    id: 'ad.ecommerce',
    group: 'ad',
    label: '电商广告',
    defaultSize: '1:1',
    fragments: {
      subject:
        'Present {product} as an unmissable promotional hero: large, glossy and angled toward the viewer, with shape, color and printed packaging text identical to the reference; no invented variants, bundles or accessories beyond what the reference image already shows.',
      scene:
        'Bold promotional backdrop in a strong brand-adjacent palette — color-block field, radial burst, geometric shapes or ribbon banners — with clear zones of high and low contrast so overlay copy stays readable.',
      lighting:
        'Punchy studio lighting: a harder key for a crisp specular signature, colored gel accents from behind for pop, bright fill keeping the product clean; controlled reflections and no blown highlights on label text.',
      composition:
        'Square 1:1 canvas with a 50mm-equivalent lens at f/8, the product large on the right or center, themed graphic blocks on the left and bottom as designated text areas, strong diagonal energy and clear hierarchy.',
      finish:
        'Retail-advertising finish: vibrant saturated color, high clarity, glossy product sheen, clean flat graphic elements, no muddy shadows.',
      copyStyle:
        'Any {brand} lockup and {slogan} appear only as reserved empty zones or clearly separated flat graphic blocks; when text is requested, use short bold sans-serif lines with generous tracking and high contrast against the background, no filler pseudo-text, no watermarks, no invented claims, and never alter text printed on the product itself.',
    },
    negativeHints:
      'No cluttered layout, no illegible overlay text, no model-invented prices or numbers, no distorted product, no extra products, no altered packaging text.',
    variables: ['product', 'brand', 'slogan'],
  },
  {
    id: 'ad.social',
    group: 'ad',
    label: '社交媒体',
    defaultSize: '4:5',
    fragments: {
      subject:
        'Show the product in a scroll-stopping, lifestyle-forward way suited to {audience}, held or staged naturally, with the product fully recognizable and its colors and printed packaging text unchanged from the reference image.',
      scene:
        'Trend-aware setting with a strong visual hook — bold color backdrop, textured paper, playful geometric props or a candid everyday moment — composed for a vertical mobile feed and still readable at thumbnail size.',
      lighting:
        'Bright, punchy, social-native lighting: soft key plus a defined rim or colored accent light, clean shadows, saturated but not radioactive color, with skin and material tones staying believable.',
      composition:
        'Vertical 4:5 mobile-first framing at a 35mm-equivalent lens and f/2.8, product in the upper or center third, generous lower and top margins reserved for captions and platform safe zones.',
      finish:
        'Crisp contemporary social aesthetic, high clarity, light creative grade, no heavy filters, no fake film borders.',
      copyStyle:
        'Any {slogan} or caption appears only in reserved blank zones or as a clean flat graphic block: short, bold, high-contrast sans-serif, centered or left-aligned, no emoji clutter, no hashtags rendered as image text, no invented claims, and packaging text on the product stays untouched.',
    },
    negativeHints:
      'No busy patterns fighting the product, no unreadable small text, no platform logos or UI screenshots, no distorted product, no duplicate items, no altered packaging text.',
    variables: ['audience', 'slogan'],
  },
  {
    id: 'ad.poster',
    group: 'ad',
    label: '活动海报',
    defaultSize: '3:4',
    fragments: {
      subject:
        'Center {product} as the main subject of the campaign, shown at heroic scale and a flattering angle with genuine shape, color and printed packaging text intact; do not invent limited editions, bundles or badges anywhere on the product.',
      scene:
        'Designed poster environment built from graphic layers — bold color fields, halftone texture, abstract shapes, confetti or light rays — arranged around the product with clear, deliberate empty regions for the headline and a {brand} lockup.',
      lighting:
        'Dramatic poster lighting: strong key with visible direction, colored backlight separating the silhouette with a soft glow, deep rich background with controlled falloff, crisp unclipped product highlights.',
      composition:
        'Vertical 3:4 poster layout at a 50mm-equivalent lens and f/8, the product at the visual center with strong symmetry or golden-ratio placement, a wide empty band at the top for the headline and one at the bottom for details.',
      finish:
        'High-impact campaign poster finish: rich saturated color, crisp graphic edges, smooth gradients, print-ready cleanliness, no compression artifacts.',
      copyStyle:
        'Any headline or {slogan} appears only as reserved blank space or a flat graphic text block: one dominant headline, optionally one short subline, bold geometric sans-serif, strong hierarchy and contrast, no filler pseudo-text, no unverified dates or discounts, and never rewrite text already printed on the product.',
    },
    negativeHints:
      'No cluttered poster collage, no overlapping unreadable text, no invented dates, prices or discounts, no distorted product, no stock-photo watermark, no altered packaging text.',
    variables: ['slogan', 'brand', 'product'],
  },

  // ─────────────────────────── tool：工具 ───────────────────────────
  {
    id: 'tool.white-bg',
    group: 'tool',
    label: '白底图',
    defaultSize: '1:1',
    requiresReference: true,
    fragments: {
      subject:
        'Re-render the exact product from the provided reference image onto a removed background: identical shape, proportions, color, material finish and every printed packaging text, with edges cut out precisely including holes, handles and thin parts; never redesign, over-retouch or invent product details.',
      scene:
        'Absolute pure white background with no gradient, no shadow, no floor line, no reflection and no props; the product sits cleanly in the frame, ready for marketplace listing use.',
      lighting:
        'Even flat studio lighting that reproduces the material appearance shown in the reference: broad soft illumination from both sides, no visible light-source reflections, no hot spots, no color cast and no shadow cast onto the background.',
      composition:
        'Square 1:1 canvas with the product centered and scaled to fill roughly 80% of the frame, straight-on or matching the reference angle exactly, even margins on all four sides and nothing cropped at the border.',
      finish:
        'Marketplace-ready cutout quality: clean anti-aliased edges, faithful color and texture, neutral white balance, no halo or fringe along the silhouette, no over-sharpening.',
    },
    negativeHints:
      'No background, no shadow, no reflection, no halo or white fringe on edges, no props, no added text, no color shift, no cropped product, no altered packaging text.',
  },
  {
    id: 'tool.style-replica',
    group: 'tool',
    label: '风格复刻',
    defaultSize: '1:1',
    requiresReference: true,
    fragments: {
      subject:
        'Reproduce the product from the reference image with complete fidelity — same form, proportions, colors, materials and printed packaging text — while transferring the visual style of the second reference: its lighting, palette, background, props and mood, without altering the product itself.',
      scene:
        'Rebuild the scene from the style reference as closely as possible: matching background material, tonal palette, decorative props and environmental texture, keeping the product as the unmistakable subject at the center of the new setting.',
      lighting:
        'Copy the lighting character of the style reference — direction, hardness, color temperature, contrast ratio, highlight shape and shadow depth — and apply it to the product without changing the existing colors or printed details of the product.',
      composition:
        'Match the framing logic of the style reference: focal length feel, camera height, crop, subject placement and negative-space distribution, while keeping the product fully visible inside the 1:1 frame.',
      finish:
        'Blend product accuracy with style fidelity: the result should look like the same product photographed inside the world of the style reference, with consistent grain, contrast and color grading across the whole frame.',
    },
    negativeHints:
      'No product redesign, no changed label text or logo, no mixed unrelated styles, no extra products, no loss of reference product details, no copied watermark or signature.',
  },
] as const satisfies readonly ModuleDef[]

/** 按 id 查找模块；未命中返回 `undefined`。 */
export function getModule(id: string): ModuleDef | undefined {
  return MODULES.find((module) => module.id === id)
}
