/**
 * 长安游伴 · 本地数据库加载模块
 * 用途：从本地JSON文件加载景点/美食/酒店/体验数据
 * 使用方法：在 index.html 中引入此文件，然后调用 window.LocalDB.xxx()
 */

(function() {
  'use strict';

  // ============================================
  // 配置
  // ============================================
  const DB_PATH = 'data/'; // JSON文件存放路径

  // ============================================
  // 数据库缓存
  // ============================================
  let cache = {
    attractions: null,
    foods: null,
    hotels: null,
    experience: null
  };

  // ============================================
  // 工具函数
  // ============================================

  // 加载JSON文件
  async function fetchJSON(filename) {
    try {
      const response = await fetch(DB_PATH + filename);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (e) {
      console.error(`加载 ${filename} 失败：`, e);
      return [];
    }
  }

  // 获取缓存或加载
  async function getDB(key, filename) {
    if (cache[key]) return cache[key];
    cache[key] = await fetchJSON(filename);
    return cache[key];
  }

  // 计算距离（Haversine公式）
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  // 格式化距离
  function fmtDist(km) {
    if (km < 1) return (km * 1000).toFixed(0) + 'm';
    return km.toFixed(1) + 'km';
  }

  // 按距离排序 + 字段别名（兼容旧渲染函数）
  function sortByDistance(items, userLat, userLng) {
    if (!userLat || !userLng) return items;
    return items.map(item => {
      var d = haversine(userLat, userLng, item.lat, item.lng);
      // 添加兼容别名：旧代码用 photos/dist/coord/amapId，DB用 images/distance/lat+lng/id
      return Object.assign({}, item, {
        distance: d,
        dist: fmtDist(d),
        photos: item.images || item.photos || [],
        photo: (item.images && item.images[0]) || item.photo || null,
        coord: (item.lng != null && item.lat != null) ? (item.lng + ',' + item.lat) : (item.coord || ''),
        amapId: item.id || item.amapId || ''
      });
    }).sort(function(a, b) { return a.distance - b.distance; });
  }

  // ============================================
  // 公开API
  // ============================================

  const LocalDB = {
    // 获取景点数据（按距离排序）
    async getAttractions(userLat, userLng) {
      const data = await getDB('attractions', 'attractions.json');
      return sortByDistance(data, userLat, userLng);
    },

    // 获取美食数据（按距离排序）
    async getFoods(userLat, userLng) {
      const data = await getDB('foods', 'foods.json');
      return sortByDistance(data, userLat, userLng);
    },

    // 获取酒店数据（按距离排序）
    async getHotels(userLat, userLng) {
      const data = await getDB('hotels', 'hotels.json');
      return sortByDistance(data, userLat, userLng);
    },

    // 获取潮流体验数据（按距离排序）
    async getExperience(userLat, userLng) {
      const data = await getDB('experience', 'experience.json');
      return sortByDistance(data, userLat, userLng);
    },

    // 按分类筛选
    filterByCat(items, cat) {
      if (!cat || cat === '全部') return items;
      return items.filter(item => item.cat === cat);
    },

    // 按价格筛选（酒店）
    filterByPrice(items, priceRange) {
      if (!priceRange || priceRange === '全部') return items;
      return items.filter(item => {
        if ((priceRange === '经济' || priceRange === '经济型') && item.cat === '经济型') return true;
        if ((priceRange === '舒适' || priceRange === '舒适型') && item.cat === '舒适型') return true;
        if ((priceRange === '豪华' || priceRange === '豪华型') && item.cat === '豪华型') return true;
        return item.cat === priceRange;
      });
    },

    // 搜索
    search(items, keyword) {
      if (!keyword) return items;
      const kw = keyword.toLowerCase();
      return items.filter(item =>
        (item.name && item.name.toLowerCase().includes(kw)) ||
        (item.desc && item.desc.toLowerCase().includes(kw)) ||
        (item.tag && item.tag.toLowerCase().includes(kw))
      );
    },

    // 获取单个条目详情
    async getItem(type, id) {
      let data;
      switch (type) {
        case 'attraction': data = await getDB('attractions', 'attractions.json'); break;
        case 'food': data = await getDB('foods', 'foods.json'); break;
        case 'hotel': data = await getDB('hotels', 'hotels.json'); break;
        case 'experience': data = await getDB('experience', 'experience.json'); break;
        default: return null;
      }
      return data.find(item => item.id === id) || null;
    },

    // 获取全部DB数据（供历史记录查看等场景使用）
    async getAllData() {
      var attractions = await getDB('attractions', 'attractions.json');
      var foods = await getDB('foods', 'foods.json');
      var hotels = await getDB('hotels', 'hotels.json');
      var experience = await getDB('experience', 'experience.json');
      return { attractions: attractions, foods: foods, hotels: hotels, experience: experience };
    },

    // 为AI规划提供数据（根据表单筛选）
    async getDataForPlan(form) {
      const attractions = await getDB('attractions', 'attractions.json');
      const foods = await getDB('foods', 'foods.json');
      const hotels = await getDB('hotels', 'hotels.json');
      const experience = await getDB('experience', 'experience.json');

      // 根据表单筛选酒店
      let filteredHotels = hotels;
      if (form.hotelType) {
        filteredHotels = LocalDB.filterByPrice(hotels, form.hotelType);
      }
      // 如果筛选后为空或太少，回退到全部舒适型+经济型
      if (filteredHotels.length < 3) {
        filteredHotels = hotels.filter(h => h.cat === '舒适型' || h.cat === '经济型');
      }

      // 根据口味偏好筛选美食
      let filteredFoods = foods;
      if (form.foodPref && form.foodPref.length > 0) {
        filteredFoods = foods.filter(f => {
          return form.foodPref.some(function(pref) {
            return f.cat && f.cat.indexOf(pref) >= 0;
          });
        });
      }
      // 再按"想吃"筛选
      if (form.foodWant && form.foodWant.length > 0 && filteredFoods.length > 5) {
        var wanted = foods.filter(f => {
          return form.foodWant.some(function(w) {
            return f.cat && f.cat.indexOf(w) >= 0;
          });
        });
        if (wanted.length > 0) filteredFoods = wanted;
      }

      // 根据旅行风格和必去景点筛选景点
      let filteredAttractions = attractions;
      if (form.styles && form.styles.length > 0) {
        var styleFiltered = attractions.filter(function(a) {
          return form.styles.some(function(s) {
            return a.cat && a.cat.indexOf(s) >= 0;
          });
        });
        if (styleFiltered.length > 0) filteredAttractions = styleFiltered;
      }
      // 必去景点优先级最高
      if (form.mustSee && form.mustSee.length > 0) {
        var mustSeeItems = attractions.filter(function(a) {
          return form.mustSee.some(function(m) {
            return a.name && a.name.indexOf(m) >= 0;
          });
        });
        if (mustSeeItems.length > 0) {
          // 合并mustSee和其他筛选结果
          var seen = {};
          var merged = [];
          mustSeeItems.forEach(function(item) { seen[item.id] = true; merged.push(item); });
          filteredAttractions.forEach(function(item) {
            if (!seen[item.id]) merged.push(item);
          });
          filteredAttractions = merged;
        }
      }

      return {
        hotels: filteredHotels.slice(0, 10),
        foods: filteredFoods.slice(0, 20),
        attractions: filteredAttractions.slice(0, 20),
        experience: experience.slice(0, 10)
      };
    }
  };

  // 暴露到全局
  window.LocalDB = LocalDB;

})();
