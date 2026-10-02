const ACTIVE_SECTION_OFFSET = 104;
const BOTTOM_EPSILON = 2;

export function activeSettingsSection(sections, {
  scrollY = 0,
  viewportHeight = 0,
  documentHeight = 0,
  activationOffset = ACTIVE_SECTION_OFFSET,
} = {}) {
  if (!sections.length) return null;

  if (scrollY > BOTTOM_EPSILON && scrollY + viewportHeight >= documentHeight - BOTTOM_EPSILON) {
    return sections[sections.length - 1].id;
  }

  let activeId = sections[0].id;
  for (const section of sections) {
    if (section.top > activationOffset) break;
    activeId = section.id;
  }
  return activeId;
}

let activeCleanup = null;

export function destroySettingsNavigation() {
  activeCleanup?.();
  activeCleanup = null;
}

export function mountSettingsNavigation(root = document) {
  destroySettingsNavigation();

  const nav = root.querySelector('.settings-nav');
  const content = root.querySelector('.settings-content');
  if (!nav || !content) return () => {};

  const links = [...nav.querySelectorAll('.settings-branch-children a[href^="#"]')];
  const sections = links.map(link => {
    const id = link.getAttribute('href').slice(1);
    const section = document.getElementById(id);
    return section ? { id, link, section } : null;
  }).filter(Boolean);
  if (!sections.length) return () => {};

  let frame = 0;
  let activeId = null;
  let resizeObserver = null;

  const setActive = id => {
    if (!id || id === activeId) return;
    activeId = id;
    for (const item of sections) {
      if (item.id === id) item.link.setAttribute('aria-current', 'location');
      else item.link.removeAttribute('aria-current');
    }

    const item = sections.find(section => section.id === id);
    if (item && nav.scrollWidth > nav.clientWidth + 1) {
      const navRect = nav.getBoundingClientRect();
      const linkRect = item.link.getBoundingClientRect();
      const inset = 8;
      let left = nav.scrollLeft;
      if (linkRect.left < navRect.left + inset) left -= navRect.left + inset - linkRect.left;
      else if (linkRect.right > navRect.right - inset) left += linkRect.right - navRect.right + inset;
      if (left !== nav.scrollLeft) {
        const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
        nav.scrollTo?.({ left, behavior: reducedMotion ? 'auto' : 'smooth' });
        if (typeof nav.scrollTo !== 'function') nav.scrollLeft = left;
      }
    }
  };

  const update = () => {
    frame = 0;
    const metrics = sections.map(({ id, section }) => {
      const rect = section.getBoundingClientRect();
      return { id, top: rect.top };
    });
    const firstSectionStyle = window.getComputedStyle?.(sections[0].section);
    const blockMargin = Number.parseFloat(firstSectionStyle?.scrollMarginBlockStart);
    const topMargin = Number.parseFloat(firstSectionStyle?.scrollMarginTop);
    const sectionScrollMargin = Number.isFinite(blockMargin) ? blockMargin : topMargin;
    const documentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const id = activeSettingsSection(metrics, {
      scrollY: window.scrollY || document.documentElement.scrollTop || 0,
      viewportHeight: window.innerHeight || document.documentElement.clientHeight || 0,
      documentHeight,
      activationOffset: Number.isFinite(sectionScrollMargin) ? sectionScrollMargin + 8 : ACTIVE_SECTION_OFFSET,
    });
    if (id) setActive(id);
  };

  const scheduleUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  const onClick = event => {
    const link = event.target.closest?.('.settings-branch-children a[href^="#"]');
    if (!link || !nav.contains(link)) return;
    const id = link.getAttribute('href').slice(1);
    const item = sections.find(section => section.id === id);
    if (!item) return;

    event.preventDefault();
    if (window.location.hash !== `#${id}`) window.history.pushState(window.history.state, '', `#${id}`);
    const reducedMotion = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    item.section.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    scheduleUpdate();
  };

  nav.addEventListener('click', onClick);
  window.addEventListener('scroll', scheduleUpdate, { passive: true });
  window.addEventListener('resize', scheduleUpdate, { passive: true });
  window.addEventListener('hashchange', scheduleUpdate);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(scheduleUpdate);
    for (const { section } of sections) resizeObserver.observe(section);
  }

  activeCleanup = () => {
    nav.removeEventListener('click', onClick);
    window.removeEventListener('scroll', scheduleUpdate);
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('hashchange', scheduleUpdate);
    resizeObserver?.disconnect();
    if (frame) window.cancelAnimationFrame(frame);
  };

  update();
  return activeCleanup;
}
