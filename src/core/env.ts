/** 设备能力分级与用户偏好 */
const coarse = matchMedia('(pointer: coarse)').matches;
const smallScreen = Math.min(screen.width, screen.height) < 700;
const weakCpu = (navigator.hardwareConcurrency || 8) <= 4;

export const tier: 'high' | 'low' = coarse || smallScreen || weakCpu ? 'low' : 'high';

const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const motion = { reduced: reducedQuery.matches };
reducedQuery.addEventListener('change', (e) => (motion.reduced = e.matches));

export const isTouch = coarse;
