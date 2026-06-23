import { Router, type IRouter } from "express";
import healthRouter from "./health";
import satcatRouter from "./satcat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(satcatRouter);

export default router;
