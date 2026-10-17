<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed } from 'vue';
import { collab } from '../stores/collab';
import { editor, fitView, mobilePanel, toggleMobilePanel } from '../stores/editor';

const zoomLabel = computed(() =>
  editor.view.autoFit ? '适应' : Math.round(editor.view.zoom * 100) + '%',
);
const activeRecord = computed(() => editor.skins.find((s) => s.id === editor.activeSkinId) ?? null);
const baseLabel = computed(() =>
  editor.baseImage ? editor.baseImage.width + ' × ' + editor.baseImage.height : '未设置',
);
/**
 * 这句是隐私声明，不是装饰：离线时图片确实一步都没出浏览器，
 * 但进了房间，底图与每一张皮肤都已经存在服务器上了。房间模式下继续挂
 * "图片不上传" 就是一句明确的假话 —— 而且恰好出现在分享链接那个场景。
 */
const privacyLabel = computed(() =>
  collab.mode === 'room' ? '房间协作 · 图片经服务器同步' : '本地计算 · 图片不上传',
);
const skinLabel = computed(() => {
  const record = activeRecord.value;
  if (!record) return '未选皮肤';
  return record.sourceLabel + ' · ' + record.meta.label;
});
</script>

<template>
  <footer class="statusbar">
    <!-- 桌面端状态栏 -->
    <div class="st-desktop">
      <span class="st"><i class="st-sq" aria-hidden="true" />画布 <b>{{ editor.document.width }} × {{ editor.document.height }} px</b></span>
      <span class="st">底图 <b>{{ baseLabel }}</b></span>
      <span class="st">头像 <b>{{ editor.layers.length }}</b> 个</span>
      <span class="st">皮肤 <b>{{ skinLabel }}</b></span>
      <span class="st">缩放 <b>{{ zoomLabel }}</b></span>
      <span class="st-right">
        <span class="beat" aria-hidden="true">
          <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
        </span>
        <span>{{ privacyLabel }}</span>
      </span>
    </div>

    <!-- 移动端底栏导航 (Dock) -->
    <nav class="st-mobile" aria-label="移动端工作区导航">
      <button
        class="m-dock-btn"
        :class="{ 'is-active': mobilePanel === 'skin' }"
        type="button"
        @click="toggleMobilePanel('skin')"
      >
        <i class="m-sq m-sq--grass" aria-hidden="true" />
        <span>素材库 ({{ editor.skins.length }})</span>
      </button>

      <button
        class="m-dock-btn m-dock-btn--fit"
        type="button"
        title="适应画布"
        @click="fitView"
      >
        <i class="m-sq" aria-hidden="true" />
        <span>适应画布</span>
      </button>

      <button
        class="m-dock-btn"
        :class="{ 'is-active': mobilePanel === 'inspector', 'has-selected': !!editor.selectedId }"
        type="button"
        @click="toggleMobilePanel('inspector')"
      >
        <i class="m-sq" :class="editor.selectedId ? 'm-sq--cyan' : ''" aria-hidden="true" />
        <span>属性/图层 ({{ editor.layers.length }})</span>
      </button>
    </nav>
  </footer>
</template>

<style scoped>
.statusbar {
  flex: none;
  background: var(--bf-white);
  border-top: 1px solid var(--bf-ink);
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink2);
  position: relative;
  z-index: 10;
}

.st-desktop {
  height: var(--bf-statusbar);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  overflow: hidden;
  white-space: nowrap;
  width: 100%;
}

.st { display: flex; align-items: center; gap: 6px; flex: none; }
.st b { font-family: var(--bf-mono); color: var(--bf-ink); font-weight: 700; }
.st-sq { width: 8px; height: 8px; background: var(--bf-ink); flex: none; }
.st-right { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
.beat { display: flex; align-items: center; gap: 3px; height: 14px; }
.beat i { display: block; width: 8px; height: 8px; background: var(--bf-ink); }
.beat i:nth-child(3n + 1) { background: var(--bf-grass); }
.beat i:nth-child(4n + 2) { background: var(--bf-gold); }
.beat i:nth-child(5n + 3) { background: var(--bf-cyan); }
.beat i:nth-child(7n) { height: 14px; }

/* 移动端 Dock */
.st-mobile {
  display: none;
}

@media (max-width: 840px) {
  .st-desktop { display: none; }
  .st-mobile {
    display: flex;
    align-items: stretch;
    height: calc(var(--bf-statusbar) + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  .m-dock-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--bf-ink);
    border-right: 1px solid var(--bf-line);
    background: var(--bf-rail);
    padding: 0 4px;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .m-dock-btn:last-child {
    border-right: none;
  }
  .m-dock-btn.is-active {
    background: var(--bf-white);
    color: var(--bf-ink);
    box-shadow: inset 0 -3px 0 var(--bf-ink);
  }
  .m-dock-btn.has-selected {
    color: var(--bf-ink);
    font-weight: 700;
  }
  .m-dock-btn:active {
    background: var(--bf-paper);
  }
  .m-sq {
    width: 8px;
    height: 8px;
    background: var(--bf-ink);
    flex: none;
  }
  .m-sq--grass { background: var(--bf-grass); }
  .m-sq--cyan { background: var(--bf-cyan); }
}
</style>
