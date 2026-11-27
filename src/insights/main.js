import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/600.css';
import './insights.css';
import { mountAppNav } from '../shared/appNav.js';
import { registerPwa } from '../shared/pwa.js';
import { startInsights } from './app.js';

mountAppNav('insights');
registerPwa();
startInsights();
