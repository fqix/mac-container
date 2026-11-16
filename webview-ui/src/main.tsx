import './styles.css';

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';

import {BuildForm} from './views/BuildForm';
import {ContainerForm} from './views/ContainerForm';
import {StatsView} from './views/StatsView';
import {SystemView} from './views/SystemView';

// One bundle serves every panel; the extension host picks the view with <body data-view>
const views = {
  stats: StatsView,
  containerForm: ContainerForm,
  buildForm: BuildForm,
  system: SystemView,
};
const View = views[document.body.dataset.view as keyof typeof views];

createRoot(document.getElementById('root')!).render(
  <StrictMode>{View ? <View /> : null}</StrictMode>,
);
