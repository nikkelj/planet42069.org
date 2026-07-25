import { Router, type IRouter } from "express";
import healthRouter from "./health";
import satcatRouter from "./satcat";
import tleRouter from "./tle";
import constellationsRouter from "./constellations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(constellationsRouter);
router.use(tleRouter);
router.use(satcatRouter);

export default router;
