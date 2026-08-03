import { Router, type IRouter } from "express";
import healthRouter from "./health";
import satcatRouter from "./satcat";
import tleRouter from "./tle";
import constellationsRouter from "./constellations";
import rpodRouter from "./rpod";

const router: IRouter = Router();

router.use(healthRouter);
router.use(rpodRouter);
router.use(constellationsRouter);
router.use(tleRouter);
router.use(satcatRouter);

export default router;
