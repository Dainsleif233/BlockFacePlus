<!--
  BlockFace+ · 房间门禁 / 状态遮罩
  Copyright 2026 Dainsleif · Apache License 2.0

  ?room= 模式下的三块界面：密码门禁、载入遮罩、过期/错误态。
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import BrandLogo from './BrandLogo.vue';
import { collab, leaveRoom, reloadRoom, submitGate } from '../stores/collab';

const password = ref('');
const show = computed(() => collab.mode === 'room' && collab.phase !== 'ready');
const isGate = computed(() => collab.phase === 'gate');
const isGone = computed(() => collab.phase === 'gone');
const isError = computed(() => collab.phase === 'error');
const isBusy = computed(() => collab.phase === 'loading' || collab.busyLoading);

async function submit(): Promise<void> {
  if (isBusy.value) return;
  await submitGate(password.value);
}
</script>

<template>
  <div v-if="show" class="gate">
    <div class="gate__card" role="dialog" aria-modal="true" aria-label="协同房间">
      <div class="gate__brand">
        <BrandLogo />
        <span class="gate__name">BlockFace+</span>
      </div>

      <template v-if="isGate">
        <p class="gate__title">这个房间需要密码</p>
        <p class="gate__hint">向发起者要访问密码，输入后进入协同编辑。</p>
        <form class="gate__form" @submit.prevent="submit">
          <input
            v-model="password"
            class="bf-inp gate__input"
            type="password"
            autocomplete="off"
            placeholder="房间密码"
            aria-label="房间密码"
          />
          <button class="bf-btn bf-btn--go gate__go" type="submit" :disabled="isBusy">进入</button>
        </form>
        <p v-if="collab.message" class="gate__err">{{ collab.message }}</p>
      </template>

      <template v-else-if="isBusy">
        <p class="gate__title">载入房间…</p>
        <p class="gate__hint">正在拉取底图与头像。</p>
      </template>

      <template v-else-if="isGone">
        <p class="gate__title">房间已过期</p>
        <p class="gate__hint">{{ collab.message || '过期时间一到，房间连同全部内容已被清理。' }}</p>
        <button class="bf-btn" type="button" @click="leaveRoom">回首页</button>
      </template>

      <template v-else-if="isError">
        <p class="gate__title">打不开这个房间</p>
        <p class="gate__hint">{{ collab.message || '出了点问题。' }}</p>
        <div class="gate__row">
          <button class="bf-btn" type="button" @click="reloadRoom">重试</button>
          <button class="bf-btn" type="button" @click="leaveRoom">回首页</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.gate {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--bf-stage) 78%, transparent);
  backdrop-filter: blur(4px);
}

.gate__card {
  width: min(400px, 100%);
  background: var(--bf-white);
  border: 2px solid var(--bf-ink);
  border-radius: var(--bf-radius);
  box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.14);
  padding: 22px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  text-align: center;
  align-items: center;
}

.gate__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.gate__name {
  font: 700 17px/1 var(--bf-mono);
  letter-spacing: 0.02em;
}

.gate__title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--bf-ink);
}

.gate__hint {
  margin: 0;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-ink2);
  overflow-wrap: anywhere;
}

.gate__form {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-top: 4px;
}

.gate__input {
  flex: 1;
  text-align: center;
  letter-spacing: 0.14em;
}

.gate__go {
  flex: none;
}

.gate__row {
  display: flex;
  gap: 8px;
}

.gate__err {
  margin: 0;
  font-size: var(--bf-font-size-sm);
  color: var(--bf-red-ink);
}
</style>
