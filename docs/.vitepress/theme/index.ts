import type { App } from 'vue'
import DefaultTheme from 'vitepress/theme'
import CustomLayout from './CustomLayout.vue'
import ObsidianFrame from './components/ObsidianFrame.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout: CustomLayout,
  enhanceApp({ app }: { app: App }) {
    app.component('ObsidianFrame', ObsidianFrame)
  },
}
