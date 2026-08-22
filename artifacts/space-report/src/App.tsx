import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import LandspaceZhuque3 from "@/pages/briefing/landspace-zhuque-3";
import Analytics from "@/pages/analytics";
import Catalog from "@/pages/catalog";
import Constellations from "@/pages/constellations";
import Rpod from "@/pages/rpod";
import { AppLayout } from "@/components/layout/app-layout";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function Router() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/analytics" component={Analytics} />
        <Route path="/briefing" component={Home} />
        <Route path="/briefing/landspace-zhuque-3" component={LandspaceZhuque3Route} />
        <Route path="/catalog" component={Catalog} />
        <Route path="/constellations" component={Constellations} />
        <Route path="/rpod" component={Rpod} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function LandspaceZhuque3Route() {
  return <LandspaceZhuque3 />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
