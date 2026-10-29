import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ContainerForm } from './views/ContainerForm';
import { StatsView } from './views/StatsView';

// One bundle serves every panel; the extension host picks the view with <body data-view>
const views = { stats: StatsView, containerForm: ContainerForm };
const View = views[document.body.dataset.view as keyof typeof views];

createRoot(document.getElementById('root')!).render(<StrictMode>{View ? <View /> : null}</StrictMode>);
