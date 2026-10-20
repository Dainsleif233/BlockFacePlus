<!-- BlockFace · Copyright 2026 Dainsleif · Apache License 2.0 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { headCache } from '../core/render/headCache';
import { editor, getSkin } from '../stores/editor';

const props = withDefaults(
  defineProps<{
    skinId: string | null;
    /** 是否叠帽子层 */
    overlay?: boolean;
    /** 是否水平翻转 */
    flipH?: boolean;
    size?: number;
  }>(),
  { overlay: true, flipH: false, size: 44 },
);

const el = ref<HTMLCanvasElement | null>(null);
const isCustom = computed(() => {
  if (editor.skinRevision < 0) return false;
  return getSkin(props.skinId)?.meta.isCustomImage === true;
});

function draw(): void {
  const canvas = el.value;
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixels = Math.max(1, Math.round(props.size * dpr));
  canvas.width = pixels;
  canvas.height = pixels;
  canvas.style.width = props.size + 'px';
  canvas.style.height = props.size + 'px';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pixels, pixels);
  const currentSkin = getSkin(props.skinId);
  if (!currentSkin) return;
  const head = headCache.get(currentSkin, props.overlay, pixels);
  if (props.flipH) {
    ctx.translate(pixels, 0);
    ctx.scale(-1, 1);
  }
  // 开帽层时离屏画布比正脸大一圈（帽沿），整图等比缩放进方形缩略图：
  // 帽沿贴到边框、正脸略缩，四周边距对称；像素皮肤关平滑保住边缘。
  ctx.imageSmoothingEnabled = Boolean(currentSkin.meta.isCustomImage);
  ctx.drawImage(head, 0, 0, pixels, pixels);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

onMounted(draw);
watch(() => [props.skinId, props.overlay, props.flipH, props.size, editor.skinRevision], draw);
defineExpose({ draw });
</script>

<template>
  <canvas ref="el" class="skin-thumb" :class="{ 'skin-thumb--smooth': isCustom }" aria-hidden="true" />
</template>

<style scoped>
.skin-thumb {
  display: block;
  image-rendering: pixelated;
}
.skin-thumb--smooth {
  image-rendering: auto;
}
</style>
