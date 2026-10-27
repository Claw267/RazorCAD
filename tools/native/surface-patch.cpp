// RazorCAD native surface construction. OpenCascade is LGPL-2.1 with the OCCT exception.
// The constrained G2 loft builder. Approximate the plate with a C2-smooth
// B-spline at a checked positional error. C2 smoothness does not establish G2 contact with
// support faces: independent final-surface derivative checks are still required.
#include <vector>
#include <array>
#include <cmath>
#include <algorithm>
#include <string>
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Curve2d.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepFill_CurveConstraint.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRep_Builder.hxx>
#include <BRep_Tool.hxx>
#include <BRepLib.hxx>
#include <Adaptor3d_CurveOnSurface.hxx>
#include <GeomConvert_ApproxSurface.hxx>
#include <GeomConvert.hxx>
#include <GeomProjLib.hxx>
#include <GeomAPI_ProjectPointOnSurf.hxx>
#include <Extrema_GenLocateExtPS.hxx>
#include <BRepClass_FaceClassifier.hxx>
#include <limits>
#include <BRepExtrema_DistShapeShape.hxx>
#include <Geom_RectangularTrimmedSurface.hxx>
#include <BRepTools.hxx>
#include <GeomAdaptor_Surface.hxx>
#include <TColgp_Array2OfPnt.hxx>
#include <TColStd_Array1OfReal.hxx>
#include <TColStd_Array1OfInteger.hxx>
#include <GeomPlate_BuildPlateSurface.hxx>
#include <GeomPlate_Surface.hxx>
#include <Geom_BSplineSurface.hxx>
#include <TColGeom2d_HArray1OfCurve.hxx>
#include <TopTools_DataMapOfShapeShape.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <Standard_Failure.hxx>

class RazorCADSurfacePatch {
  static bool sameCurve(const TopoDS_Edge& a, const TopoDS_Edge& b) {
    if (a.IsSame(b)) return true;
    TopLoc_Location la, lb;
    double af, al, bf, bl;
    auto ca = BRep_Tool::Curve(a, la, af, al);
    auto cb = BRep_Tool::Curve(b, lb, bf, bl);
    return ca == cb && la.IsEqual(lb) && std::abs(af-bf) < 1e-9 && std::abs(al-bl) < 1e-9;
  }
  // Uniform clamped cubic interpolation. Interior knot multiplicities are one (C2).
  // Endpoint derivatives are supplied by the plate, avoiding estimated end tangents.
  // Interior sample equations have weights (1/6, 4/6, 1/6). At the first/last
  // sample they are (1/4, 7/12, 1/6), mirrored at the other end. The fixed end
  // poles encode the derivatives; Thomas elimination solves all XYZ coordinates.
  static std::vector<gp_XYZ> cubicPoles(const std::vector<gp_XYZ>& values,
                                      const gp_XYZ& firstDerivative,
                                      const gp_XYZ& lastDerivative, double step) {
    const int n = static_cast<int>(values.size())-1;
    if (n < 4 || !(step > 0)) throw Standard_Failure("Invalid cubic interpolation grid");
    std::vector<gp_XYZ> poles(n+3), rhs(n-1);
    std::vector<double> diagonal(n-1, 2.0/3.0);
    poles[0] = values[0]; poles[1] = values[0]+firstDerivative*(step/3);
    poles[n+2] = values[n]; poles[n+1] = values[n]-lastDerivative*(step/3);
    diagonal.front() = diagonal.back() = 7.0/12.0;
    for (int i = 1; i < n; ++i) rhs[i-1] = values[i];
    rhs.front() -= poles[1]*0.25; rhs.back() -= poles[n+1]*0.25;
    for (int i = 1; i < n-1; ++i) {
      const double factor = (1.0/6.0)/diagonal[i-1];
      diagonal[i] -= factor/6.0; rhs[i] -= rhs[i-1]*factor;
    }
    poles[n] = rhs.back()/diagonal.back();
    for (int i = n-3; i >= 0; --i) poles[i+2] = (rhs[i]-poles[i+3]/6.0)/diagonal[i];
    return poles;
  }
  static Handle(Geom_BSplineSurface) interpolateC2(const Handle(GeomPlate_Surface)& original, int count) {
    double u0,u1,v0,v1; original->Bounds(u0,u1,v0,v1);
    const double hu=(u1-u0)/count, hv=(v1-v0)/count;
    std::vector<std::vector<gp_XYZ>> rows(count+1), boundaryDerivatives(2);
    gp_Pnt p; gp_Vec du,dv,duu,dvv,duv;
    for (int i=0; i<=count; ++i) {
      const double u=u0+hu*i;
      std::vector<gp_XYZ> values(count+1);
      for (int j=0; j<=count; ++j) values[j]=original->Value(u,v0+hv*j).XYZ();
      original->D1(u,v0,p,du,dv); const gp_XYZ first=dv.XYZ();
      original->D1(u,v1,p,du,dv);
      rows[i]=cubicPoles(values,first,dv.XYZ(),hv);
    }
    // Differentiate the same linear V interpolation to obtain the exact U-clamp
    // data for its control points, including the plate's mixed derivative at corners.
    for (int side=0; side<2; ++side) {
      const double u=side ? u1 : u0;
      std::vector<gp_XYZ> values(count+1); gp_XYZ first,last;
      for (int j=0; j<=count; ++j) {
        original->D2(u,v0+hv*j,p,du,dv,duu,dvv,duv); values[j]=du.XYZ();
        if (j==0) first=duv.XYZ(); if (j==count) last=duv.XYZ();
      }
      boundaryDerivatives[side]=cubicPoles(values,first,last,hv);
    }
    TColgp_Array2OfPnt poles(1,count+3,1,count+3);
    for (int j=0; j<count+3; ++j) {
      std::vector<gp_XYZ> values(count+1);
      for (int i=0; i<=count; ++i) values[i]=rows[i][j];
      const auto column=cubicPoles(values,boundaryDerivatives[0][j],boundaryDerivatives[1][j],hu);
      for (int i=0; i<count+3; ++i) poles.SetValue(i+1,j+1,gp_Pnt(column[i]));
    }
    TColStd_Array1OfReal uk(1,count+1),vk(1,count+1);
    TColStd_Array1OfInteger multiplicities(1,count+1);
    for (int i=0; i<=count; ++i) {
      uk(i+1)=u0+hu*i; vk(i+1)=v0+hv*i; multiplicities(i+1)=(i==0 || i==count) ? 4 : 1;
    }
    return new Geom_BSplineSurface(poles,uk,vk,multiplicities,multiplicities,3,3);
  }
  static std::array<gp_XYZ,7> differential(const Adaptor3d_Surface& surface, const gp_Pnt2d& uv) {
    gp_Pnt p; gp_Vec du,dv,duu,dvv,duv;
    surface.D2(uv.X(),uv.Y(),p,du,dv,duu,dvv,duv);
    const double E=du.Dot(du),F=du.Dot(dv),G=dv.Dot(dv),det=E*G-F*F;
    if (!std::isfinite(det) || !(det>1e-14*E*G))
      throw Standard_Failure("The final constrained surface has a singular parameterization");
    return {p.XYZ(),du.XYZ(),dv.XYZ(),duu.XYZ(),dvv.XYZ(),duv.XYZ(),du.Crossed(dv).Normalized().XYZ()};
  }
  static double second(const std::array<gp_XYZ,7>& jet, const gp_XYZ& w, const gp_XYZ& z) {
    const auto& du=jet[1]; const auto& dv=jet[2]; const auto& normal=jet[6];
    const double E=du.Dot(du),F=du.Dot(dv),G=dv.Dot(dv),det=E*G-F*F;
    const double a=(w.Dot(du)*G-w.Dot(dv)*F)/det,b=(w.Dot(dv)*E-w.Dot(du)*F)/det;
    const double c=(z.Dot(du)*G-z.Dot(dv)*F)/det,d=(z.Dot(dv)*E-z.Dot(du)*F)/det;
    return normal.Dot(jet[3])*a*c+normal.Dot(jet[5])*(a*d+b*c)+normal.Dot(jet[4])*b*d;
  }
  static double verifyBoundary(const Handle(Geom_BSplineSurface)& surface,
      const Handle(TColGeom2d_HArray1OfCurve)& curves,
      const std::vector<TopoDS_Edge>& edges, const std::vector<TopoDS_Edge>& supportEdges,
      const std::vector<TopoDS_Face>& supports, int order, double tolerance) {
    GeomAdaptor_Surface candidate(surface);
    double worst=0;
    for (size_t i=0; i<edges.size(); ++i) {
      BRepAdaptor_Curve edge(edges[i]);
      Handle(Geom2d_Curve) onSupport; double first,last;
      if (order && !supports[i].IsNull())
        onSupport=BRep_Tool::CurveOnSurface(supportEdges[i],supports[i],first,last);
      for (int j=0; j<33; ++j) {
        const double t=edge.FirstParameter()+(edge.LastParameter()-edge.FirstParameter())
          *(1-std::cos(3.141592653589793*(j+0.5)/33))/2;
        const gp_Pnt2d uv=curves->Value(static_cast<int>(i+1))->Value(t);
        gp_Pnt point; gp_Vec tangent; edge.D1(t,point,tangent);
        const double error=candidate.Value(uv.X(),uv.Y()).Distance(point);
        if (!std::isfinite(error) || error>tolerance)
          throw Standard_Failure("The final B-spline failed the boundary contact check");
        worst=std::max(worst,error);
        if (order && !supports[i].IsNull()) {
          if (onSupport.IsNull()) throw Standard_Failure("A guide has no support parameter curve");
          BRepAdaptor_Surface support(supports[i]);
          const auto a=differential(support,onSupport->Value(t)),b=differential(candidate,uv);
          const double dot=a[6].Dot(b[6]),sign=dot<0 ? -1 : 1;
          const double angle=std::acos(std::min(1.0,std::abs(dot)));
          if (!std::isfinite(angle) || angle>0.5*3.141592653589793/180)
            throw Standard_Failure("The final B-spline failed the guide tangency check");
          if (order==2) {
            tangent-=gp_Vec(a[6])*tangent.Dot(gp_Vec(a[6])); tangent.Normalize();
            const gp_XYZ along=tangent.XYZ(),across=a[6].Crossed(along);
            const double curvature=std::max({std::abs(second(a,along,along)-sign*second(b,along,along)),
              std::abs(second(a,across,across)-sign*second(b,across,across)),
              std::abs(second(a,along,across)-sign*second(b,along,across))});
            if (!std::isfinite(curvature) || curvature>0.001)
              throw Standard_Failure("The final B-spline failed the guide curvature check");
          }
        }
      }
    }
    return worst;
  }
public:
  // Normalized edge parameter -> the actual trimming curve on the final face.
  static gp_Pnt2d UV(const TopoDS_Edge& edge, const TopoDS_Face& face, double t) {
    double first,last; const auto curve=BRep_Tool::CurveOnSurface(edge,face,first,last);
    if (curve.IsNull()) throw Standard_Failure("The boundary has no surface parameter curve");
    return curve->Value(first+(last-first)*t);
  }
private:
  static TopoDS_Shape build(const TopoDS_Shape& domains, const TopoDS_Shape& supports,
                          int order, double tolerance, int segments, int degree, int approximationOrder, const TopoDS_Face& reference) {
    if (order < 0 || order > 2 || !std::isfinite(tolerance) || tolerance <= 0 || segments < 1 || degree < 3 || approximationOrder < 0 || approximationOrder > 2)
      throw Standard_Failure("Invalid native surface-patch settings");
    std::vector<TopoDS_Wire> wires;
    std::vector<TopoDS_Edge> allEdges; std::vector<int> uses;
    for (TopExp_Explorer w(domains,TopAbs_WIRE);w.More();w.Next()) {
      wires.push_back(TopoDS::Wire(w.Current()));
      for (BRepTools_WireExplorer e(wires.back());e.More();e.Next()) {
        size_t i=0; while(i<allEdges.size() && !sameCurve(allEdges[i],e.Current())) ++i;
        if(i==allEdges.size()){allEdges.push_back(e.Current());uses.push_back(0);} ++uses[i];
      }
    }
    if(wires.empty()) throw Standard_Failure("A surface patch needs a closed boundary");
    std::vector<TopoDS_Edge> edges,supportedEdges;
    std::vector<TopoDS_Face> supportFaces;
    bool hasSupport=false; int boundaryCount=0;
    // Outer boundaries precede internal guide constraints in GeomPlate.
    for(int internal=0;internal<2;++internal)for(size_t i=0;i<allEdges.size();++i){
      if((uses[i]>1)!=bool(internal))continue;
      if(uses[i]>2)throw Standard_Failure("A guide has more than two adjacent domains");
      TopoDS_Edge selected;TopoDS_Face face;
      if(!internal)for(TopExp_Explorer f(supports,TopAbs_FACE);f.More()&&face.IsNull();f.Next())
        for(TopExp_Explorer e(f.Current(),TopAbs_EDGE);e.More();e.Next())if(sameCurve(allEdges[i],TopoDS::Edge(e.Current()))){
          face=TopoDS::Face(f.Current());selected=TopoDS::Edge(e.Current());break;
        }
      edges.push_back(allEdges[i]);supportedEdges.push_back(selected);supportFaces.push_back(face);
      hasSupport|=!face.IsNull(); if(!internal)++boundaryCount;
    }
    if(order && TopExp_Explorer(supports,TopAbs_FACE).More() && !hasSupport)
      throw Standard_Failure("The guide has no matching support boundary");
    if(boundaryCount<3)throw Standard_Failure("A surface patch needs a closed outer boundary");
    Handle(Geom_BSplineSurface) surface;
    Handle(TColGeom2d_HArray1OfCurve) curves;
    double approximationError=0,nodeError=0,fitError=0;
    if(!reference.IsNull()){
      const auto original=BRep_Tool::Surface(reference);
      surface=Handle(Geom_BSplineSurface)::DownCast(original->Copy());
      if(surface.IsNull()){
        double u0,u1,v0,v1;BRepTools::UVBounds(reference,u0,u1,v0,v1);
        Handle(Geom_Surface) bounded=new Geom_RectangularTrimmedSurface(original,u0,u1,v0,v1);
        surface=GeomConvert::SurfaceToBSplineSurface(bounded);
      }
      surface->IncreaseDegree(std::max(3,surface->UDegree()),std::max(3,surface->VDegree()));
      if(!surface->IsCNu(2)||!surface->IsCNv(2))throw Standard_Failure("The reference surface is not C2-smooth");
      curves=new TColGeom2d_HArray1OfCurve(1,static_cast<int>(edges.size()));
      for(size_t i=0;i<edges.size();++i){
        double first,last;const auto curve=BRep_Tool::Curve(edges[i],first,last);
        if(curve.IsNull())throw Standard_Failure("A boundary has no spatial curve");
        double projectionTolerance=tolerance*0.1;
        auto projected=GeomProjLib::Curve2d(curve,first,last,surface,projectionTolerance);
        if(projected.IsNull())throw Standard_Failure("A guide could not be projected onto the reference surface");
        curves->SetValue(static_cast<int>(i+1),projected);
      }
    }else{
    const double fitTolerance=tolerance*0.1; // Reserve budget for final conversion.
    const int samples=33;
    const int plateDegree=order==2 && hasSupport ? 4 : 3;
    GeomPlate_BuildPlateSurface plate(plateDegree,samples,(order==2&&hasSupport)?3:6,
                                    fitTolerance*0.1,fitTolerance,1e-4,1e-4,false);
    for (size_t i = 0; i < edges.size(); ++i) {
      Handle(GeomPlate_CurveConstraint) constraint;
      if (order && !supportFaces[i].IsNull()) {
        Handle(BRepAdaptor_Surface) surface = new BRepAdaptor_Surface(supportFaces[i]);
        Handle(BRepAdaptor_Curve2d) curve = new BRepAdaptor_Curve2d(supportedEdges[i], supportFaces[i]);
        Handle(Adaptor3d_CurveOnSurface) onSurface = new Adaptor3d_CurveOnSurface(curve, surface);
        // GeomPlate uses derivative orders 0/1/2, not GeomAbs enum values 0/1/3.
        constraint = new BRepFill_CurveConstraint(onSurface, order, samples, fitTolerance, 1e-4, 1e-4);
      } else {
        Handle(BRepAdaptor_Curve) curve = new BRepAdaptor_Curve(edges[i]);
        Handle(Adaptor3d_Curve) base = curve;
        constraint = new BRepFill_CurveConstraint(base, 0, samples, fitTolerance);
      }
      plate.Add(constraint);
    }
    plate.SetNbBounds(boundaryCount); plate.Perform();
    if (!plate.IsDone()) throw Standard_Failure("The native guide constraints did not converge");
    if (!std::isfinite(plate.G0Error()) || plate.G0Error()>tolerance*10)
      throw Standard_Failure(("The native guide constraints did not converge (G0="+std::to_string(plate.G0Error())
        +", G1="+std::to_string(plate.G1Error())+", G2="+std::to_string(plate.G2Error())+")").c_str());
    if (order == 2) {
      // Interpolate in uniform plate parameters, producing a C2 cubic spline directly.
      // Use the original UV domain, preserving all guide parameter curves.
      const auto original = plate.Surface();
      double u0, u1, v0, v1; original->Bounds(u0, u1, v0, v1);
      if (!std::isfinite(u0+u1+v0+v1) || !(u1 > u0) || !(v1 > v0))
        throw Standard_Failure("The plate has an invalid parameter domain");
      const int count = std::max(8, std::min(128, segments));
      surface = interpolateC2(original,count);
      if (!surface->IsCNu(2) || !surface->IsCNv(2))
        throw Standard_Failure("The interpolated surface is not C2-smooth");
      for (int i = 0; i <= count; ++i) for (int j = 0; j <= count; ++j) {
        const double u=u0+(u1-u0)*i/count, v=v0+(v1-v0)*j/count;
        const double error=surface->Value(u,v).Distance(original->Value(u,v));
        if (!std::isfinite(error)) throw Standard_Failure("The C2 interpolation has non-finite node error");
        nodeError=std::max(nodeError,error);
      }
      // Independent of the interpolation nodes. This is a sampled error, not a global bound.
      for (int i = 0; i < count; ++i) for (int j = 0; j < count; ++j) {
        const double u = u0+(u1-u0)*(i+0.37)/count, v = v0+(v1-v0)*(j+0.61)/count;
        const double error = surface->Value(u,v).Distance(original->Value(u,v));
        if (!std::isfinite(error)) throw Standard_Failure("The C2 interpolation has non-finite error");
        approximationError = std::max(approximationError, error);
      }
    } else {
      const GeomAbs_Shape smoothness[] = {GeomAbs_C0, GeomAbs_C1, GeomAbs_C2};
      GeomConvert_ApproxSurface approximate(plate.Surface(), tolerance * 0.1,
        smoothness[approximationOrder], smoothness[approximationOrder], degree, degree, segments, 1);
      if (!approximate.HasResult())
        throw Standard_Failure("The final B-spline approximation produced no surface");
      surface = approximate.Surface(); approximationError = approximate.MaxError();
    }
    approximationError=std::max(approximationError,nodeError);
    if (!std::isfinite(approximationError) || plate.G0Error()+approximationError > tolerance)
      throw Standard_Failure(("The final B-spline approximation exceeded its error budget: "
        + std::to_string(approximationError) + " (node error " + std::to_string(nodeError) + ")").c_str());
    curves = plate.Curves2d();
    fitError=plate.G0Error();
    }
    const double boundaryError=verifyBoundary(surface,curves,edges,supportedEdges,supportFaces,order,tolerance);
    const double budget=std::max({1e-7,fitError+approximationError,boundaryError});
    BRep_Builder builder;
    TopTools_DataMapOfShapeShape vertices;
    std::vector<TopoDS_Edge> madeEdges;
    auto vertex = [&](const TopoDS_Vertex& original) {
      auto key = original.Oriented(TopAbs_FORWARD);
      if (!vertices.IsBound(key)) {
        TopoDS_Vertex copy = BRepBuilderAPI_MakeVertex(BRep_Tool::Pnt(original));
        builder.UpdateVertex(copy, budget); vertices.Bind(key, copy);
      }
      return TopoDS::Vertex(vertices.Find(key));
    };
    for (size_t i = 0; i < edges.size(); ++i) {
      TopoDS_Edge forward = edges[i]; forward.Orientation(TopAbs_FORWARD);
      TopoDS_Vertex a, b; TopExp::Vertices(forward, a, b);
      TopoDS_Edge made = TopoDS::Edge(forward.EmptyCopied());
      builder.Add(made, vertex(a).Oriented(TopAbs_FORWARD));
      builder.Add(made, vertex(b).Oriented(TopAbs_REVERSED));
      builder.UpdateEdge(made, curves->Value(static_cast<int>(i+1)), surface, TopLoc_Location(), budget);
      BRepLib::SameParameter(made, budget, true);
      made.Orientation(TopAbs_FORWARD); madeEdges.push_back(made);
    }
    TopoDS_Compound compound;builder.MakeCompound(compound); TopoDS_Face firstFace;
    for(const auto& domain:wires){
      BRepBuilderAPI_MakeWire wire;
      for(BRepTools_WireExplorer it(domain);it.More();it.Next()){
        size_t i=0;while(i<edges.size()&&!sameCurve(edges[i],it.Current()))++i;
        if(i==edges.size())throw Standard_Failure("A domain lost a native boundary");
        TopoDS_Edge made=madeEdges[i];made.Orientation(it.Current().Orientation());wire.Add(made);
      }
      if(!wire.IsDone())throw Standard_Failure("The constrained boundary could not be assembled");
      BRepBuilderAPI_MakeFace face(surface,wire.Wire(),true);
      if(!face.IsDone()||!BRepCheck_Analyzer(face.Face(),true).IsValid())
        throw Standard_Failure("The constrained patch has an invalid boundary representation");
      if(firstFace.IsNull())firstFace=face.Face();builder.Add(compound,face.Face());
    }
    // SameParameter may adjust trimming curves. Recheck the actual curves stored on
    // the completed face, rather than trusting only the pre-trimming approximation.
    Handle(TColGeom2d_HArray1OfCurve) finalCurves=new TColGeom2d_HArray1OfCurve(1,static_cast<int>(edges.size()));
    for (size_t i=0; i<madeEdges.size(); ++i) {
      double first,last; auto curve=BRep_Tool::CurveOnSurface(madeEdges[i],firstFace,first,last);
      if (curve.IsNull()) throw Standard_Failure("A final boundary lost its parameter curve");
      finalCurves->SetValue(static_cast<int>(i+1),curve);
    }
    verifyBoundary(surface,finalCurves,edges,supportedEdges,supportFaces,order,tolerance);
    return wires.size()==1 ? TopoDS_Shape(firstFace) : TopoDS_Shape(compound);
  }
public:
  // A bounded local search for contact queries. A failed or distant result must
  // fall back to the global distance algorithm; it is never a general minimum.
  static gp_Pnt NearPoint(const TopoDS_Face& face,const gp_Pnt& point,double tolerance){
    BRepAdaptor_Surface surface(face,true);
    const double u0=surface.FirstUParameter(),u1=surface.LastUParameter();
    const double v0=surface.FirstVParameter(),v1=surface.LastVParameter();
    std::vector<std::array<double,3>> seeds;
    for(int i=0;i<=8;i++) for(int j=0;j<=8;j++){
      const double u=u0+(u1-u0)*i/8,v=v0+(v1-v0)*j/8;
      seeds.push_back({surface.Value(u,v).SquareDistance(point),u,v});
    }
    std::sort(seeds.begin(),seeds.end());
    Extrema_GenLocateExtPS locate(surface);
    for(int i=0;i<4;i++){
      locate.Perform(point,seeds[i][1],seeds[i][2],true);
      if(!locate.IsDone() || locate.SquareDistance()>tolerance*tolerance) continue;
      double u,v;locate.Point().Parameter(u,v);
      BRepClass_FaceClassifier classifier(face,gp_Pnt2d(u,v),Precision::Confusion());
      if(classifier.State()==TopAbs_IN || classifier.State()==TopAbs_ON) return locate.Point().Value();
    }
    const double invalid=std::numeric_limits<double>::quiet_NaN();
    return gp_Pnt(invalid,invalid,invalid);
  }
  // The generated bindings omit destructors for these nonvirtual query classes.
  // Called only when the JS lifetime shim has confirmed its destructor is empty.
  static void DestroyProjection(GeomAPI_ProjectPointOnSurf& query){ delete &query; }
  static void DestroyDistance(BRepExtrema_DistShapeShape& query){ delete &query; }
  static TopoDS_Face Build(const TopoDS_Wire& boundary,const TopoDS_Shape& supports,
                          int order,double tolerance,int segments,int degree,int approximationOrder=1){
    return TopoDS::Face(build(boundary,supports,order,tolerance,segments,degree,approximationOrder,TopoDS_Face()));
  }
  static TopoDS_Shape BuildNetwork(const TopoDS_Shape& domains,int order,double tolerance,int segments,int degree){
    return build(domains,TopoDS_Shape(),order,tolerance,segments,degree,1,TopoDS_Face());
  }
  static TopoDS_Shape BuildNetworkOnSurface(const TopoDS_Shape& domains,const TopoDS_Face& reference,double tolerance){
    return build(domains,TopoDS_Shape(),2,tolerance,16,3,1,reference);
  }
};
