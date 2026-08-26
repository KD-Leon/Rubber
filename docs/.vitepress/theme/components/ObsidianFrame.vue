<script setup lang="ts">
import { computed } from 'vue'

type FrameTheme = 'light' | 'dark' | 'auto'

const props = withDefaults(
  defineProps<{
    view: string
    theme?: FrameTheme
    caption?: string
    src?: string
  }>(),
  {
    theme: 'auto',
    caption: '',
    src: '',
  },
)

const themeClass = computed(() => {
  if (props.theme === 'light') return 'of-theme-light'
  if (props.theme === 'dark') return 'of-theme-dark'
  return 'of-theme-auto'
})

const hasImage = computed(() => Boolean(props.src && props.src.length > 0))
</script>

<template>
  <figure class="obsidian-frame" :class="themeClass">
    <div class="of-window">
      <div class="of-titlebar">
        <div class="of-traffic" aria-hidden="true">
          <span class="of-dot of-dot-red" />
          <span class="of-dot of-dot-yellow" />
          <span class="of-dot of-dot-green" />
        </div>
        <div class="of-title" :title="props.view">{{ props.view }}</div>
        <div class="of-titlebar-spacer" aria-hidden="true" />
      </div>

      <div class="of-tabstrip" role="tablist">
        <div class="of-tab of-tab-active" role="tab" :aria-label="props.view">
          <span class="of-tab-dot" aria-hidden="true" />
          <span class="of-tab-label">{{ props.view }}</span>
        </div>
      </div>

      <div class="of-body">
        <aside class="of-rail" aria-hidden="true">
          <span class="of-rail-pip" />
          <span class="of-rail-pip" />
          <span class="of-rail-pip" />
          <span class="of-rail-pip" />
        </aside>

        <div class="of-content">
          <img
            v-if="hasImage"
            :src="props.src"
            :alt="props.view"
            class="of-image"
            loading="lazy"
          />
          <div v-else class="of-slot">
            <slot />
          </div>
        </div>
      </div>
    </div>

    <figcaption v-if="props.caption" class="of-caption">
      {{ props.caption }}
    </figcaption>
  </figure>
</template>

<style scoped>
.obsidian-frame {
  --of-bg: var(--vp-c-bg, #ffffff);
  --of-bg-soft: var(--vp-c-bg-soft, #f6f6f7);
  --of-border: var(--vp-c-border, #e2e2e3);
  --of-text-1: var(--vp-c-text-1, #213547);
  --of-text-2: var(--vp-c-text-2, #5c6c7c);
  --of-brand: var(--vp-c-brand-1, #7c3aed);
  --of-shadow: 0 6px 22px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04);

  margin: 1.5rem 0;
  display: block;
}

.of-theme-light {
  --of-bg: #ffffff;
  --of-bg-soft: #f6f6f7;
  --of-border: #e2e2e3;
  --of-text-1: #213547;
  --of-text-2: #5c6c7c;
}

.of-theme-dark {
  --of-bg: #1b1b1f;
  --of-bg-soft: #202127;
  --of-border: #2e2e32;
  --of-text-1: #dfdfd6;
  --of-text-2: #98989f;
  --of-shadow: 0 6px 22px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
}

.of-window {
  border-radius: 12px;
  border: 1px solid var(--of-border);
  background: var(--of-bg);
  box-shadow: var(--of-shadow);
  overflow: hidden;
}

.of-titlebar {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--of-bg-soft);
  border-bottom: 1px solid var(--of-border);
  min-height: 32px;
}

.of-traffic {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.of-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  display: inline-block;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.of-dot-red {
  background: #ff5f57;
}

.of-dot-yellow {
  background: #febc2e;
}

.of-dot-green {
  background: #28c840;
}

.of-title {
  text-align: center;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--of-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0.1px;
}

.of-titlebar-spacer {
  width: 54px;
}

.of-tabstrip {
  display: flex;
  gap: 4px;
  padding: 6px 10px 0 10px;
  background: var(--of-bg-soft);
  border-bottom: 1px solid var(--of-border);
}

.of-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--of-border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  background: var(--of-bg);
  font-size: 12px;
  color: var(--of-text-1);
  max-width: 280px;
}

.of-tab-active {
  position: relative;
  top: 1px;
}

.of-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--of-brand);
  display: inline-block;
}

.of-tab-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.of-body {
  display: grid;
  grid-template-columns: 24px 1fr;
  background: var(--of-bg);
}

.of-rail {
  border-right: 1px solid var(--of-border);
  background: var(--of-bg-soft);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  opacity: 0.7;
}

.of-rail-pip {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  background: var(--of-border);
}

.of-content {
  background: var(--of-bg);
  min-height: 80px;
  display: block;
}

.of-image {
  display: block;
  width: 100%;
  height: auto;
  object-fit: cover;
}

.of-slot {
  padding: 12px 14px;
  color: var(--of-text-1);
}

.of-slot :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
}

.of-slot :deep(p) {
  margin: 0;
}

.of-caption {
  margin-top: 8px;
  font-size: 13px;
  color: var(--of-text-2);
  text-align: center;
  line-height: 1.4;
}

@media (max-width: 600px) {
  .of-titlebar {
    grid-template-columns: auto 1fr;
    gap: 8px;
  }

  .of-titlebar-spacer {
    display: none;
  }

  .of-title {
    text-align: left;
    font-size: 12px;
  }

  .of-tabstrip {
    padding: 6px 6px 0 6px;
  }

  .of-tab {
    max-width: 60vw;
    padding: 5px 10px;
  }

  .of-body {
    grid-template-columns: 16px 1fr;
  }

  .of-rail {
    padding: 8px 0;
    gap: 8px;
  }

  .of-rail-pip {
    width: 8px;
    height: 8px;
  }
}
</style>
